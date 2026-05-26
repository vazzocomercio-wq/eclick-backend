import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../../../common/supabase'
import { LlmService } from '../../../ai/llm.service'
import { GeoTelemetryService } from '../../geo-score/services/geo-telemetry.service'
import { DescriptionBuilderService } from './description-builder.service'
import { ScrapedListing } from '../../shared/types'

/**
 * GEO Rank Simulator (método do E-GEO, arXiv 2511.20867 — ver [[geo-papers]]).
 * Simula o motor de IA como RE-RANKER: gera queries realistas de comprador,
 * monta um páreo (produto-alvo + CONCORRENTES) e pede a um LLM pra ranquear —
 * medindo a POSIÇÃO do produto. Roda com a descrição ATUAL e com a OTIMIZADA
 * → delta de posição. Métrica direta de visibilidade em IA, sem crawl real.
 *
 * Páreo em camadas (v2): (1) concorrentes REAIS do Radar (radar_competitor_links);
 * (2) concorrentes "típicos de mercado" gerados por IA quando não há Radar;
 * (3) fallback: irmãos de categoria do próprio catálogo. 100% leitura.
 */

const N_QUERIES = 4
const MAX_PEERS = 6
const MIN_CANDIDATES = 3

export type CandidateSource = 'radar' | 'synthetic' | 'catalog'
export interface SimQueryResult { query: string; rank_before: number | null; rank_after: number | null }
export interface RankSimReport {
  product_id:       string | null
  title:            string
  category:         string | null
  candidate_count:  number
  candidate_source: CandidateSource | null
  queries:          SimQueryResult[]
  avg_rank_before:  number | null
  avg_rank_after:   number | null
  rank_delta:       number | null  // before - after (positivo = subiu no ranking)
  optimized:        boolean
  note:             string | null
}

interface ProductRow {
  id: string; name: string | null; category: string | null
  description: string | null; ai_short_description: string | null; ai_long_description: string | null
  price: number | null; review_count: number | null; review_avg: number | null; attributes: unknown
}
interface Candidate { title: string; desc: string }

function extractMlId(url: string): string | null {
  const m = url.match(/MLB-?(\d{6,})(?![\w])/i)
  if (m && !/MLB[UAB]/i.test(m[0])) return `MLB${m[1]}`
  return null
}
function extractStoreProductId(url: string): string | null {
  const m = url.match(/\/produto\/([0-9a-f-]{8,})/i)
  return m ? m[1] : null
}
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}
function shortDesc(p: ProductRow, max = 320): string {
  const raw = p.ai_short_description || p.description || p.ai_long_description || ''
  return String(raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

@Injectable()
export class RankSimulatorService {
  private readonly logger = new Logger(RankSimulatorService.name)

  constructor(
    private readonly llm:          LlmService,
    private readonly descriptions: DescriptionBuilderService,
    private readonly telemetry:    GeoTelemetryService,
  ) {}

  async simulate(orgId: string, url: string, userId?: string): Promise<RankSimReport> {
    const target = await this.resolveTarget(orgId, url)
    if (!target) throw new BadRequestException('Produto não encontrado no catálogo pra esta URL.')

    const base = {
      product_id: target.id, title: target.name ?? '(sem título)', category: target.category,
    }
    const empty = (note: string): RankSimReport => ({
      ...base, candidate_count: 0, candidate_source: null, queries: [],
      avg_rank_before: null, avg_rank_after: null, rank_delta: null, optimized: false, note,
    })
    if (!target.category) return empty('no_category')

    const { candidates, source } = await this.loadCandidates(orgId, target)
    if (candidates.length < 1) return empty('insufficient_candidates')

    // 1) Queries realistas de comprador + 2) descrição otimizada (em paralelo).
    const [queries, optimized] = await Promise.all([
      this.genQueries(orgId, target),
      this.optimizedDescription(orgId, target),
    ])
    if (queries.length === 0) return empty('query_gen_failed')

    const targetTitle = target.name ?? ''
    const beforeDesc = shortDesc(target, 600) || targetTitle
    const afterDesc  = (optimized || beforeDesc).slice(0, 600)

    const results: SimQueryResult[] = []
    for (const q of queries) {
      const [rb, ra] = await Promise.all([
        this.rankTarget(orgId, q, targetTitle, beforeDesc, candidates),
        this.rankTarget(orgId, q, targetTitle, afterDesc, candidates),
      ])
      results.push({ query: q, rank_before: rb, rank_after: ra })
    }

    const before = results.map(r => r.rank_before).filter((n): n is number => n != null)
    const after  = results.map(r => r.rank_after).filter((n): n is number => n != null)
    const avgB = before.length ? +(before.reduce((s, n) => s + n, 0) / before.length).toFixed(2) : null
    const avgA = after.length ? +(after.reduce((s, n) => s + n, 0) / after.length).toFixed(2) : null
    const delta = (avgB != null && avgA != null) ? +(avgB - avgA).toFixed(2) : null

    const report: RankSimReport = {
      ...base, candidate_count: candidates.length + 1, candidate_source: source, queries: results,
      avg_rank_before: avgB, avg_rank_after: avgA, rank_delta: delta, optimized: !!optimized, note: null,
    }
    await this.telemetry.emit({
      orgId, userId: userId ?? '', jobId: 'rank_sim', feature: 'geo_optimizer',
      eventName: 'geo_optimizer.rank_simulated',
      properties: { product_id: target.id, source, candidates: candidates.length + 1, avg_before: avgB, avg_after: avgA, delta },
    }).catch(() => {})
    this.logger.log(`[rank-sim] org=${orgId} prod=${target.id} fonte=${source} antes=${avgB} depois=${avgA} delta=${delta} (n=${candidates.length + 1})`)
    return report
  }

  // ── resolução de alvo ──────────────────────────────────────────────────────

  private async resolveTarget(orgId: string, url: string): Promise<ProductRow | null> {
    const sel = 'id, name, category, description, ai_short_description, ai_long_description, price, review_count, review_avg, attributes'
    const storeId = extractStoreProductId(url)
    if (storeId) {
      const { data } = await supabaseAdmin.from('products').select(sel).eq('organization_id', orgId).eq('id', storeId).maybeSingle()
      if (data) return data as ProductRow
    }
    const mlb = extractMlId(url)
    if (mlb) {
      const { data: pl } = await supabaseAdmin.from('product_listings').select('product_id').eq('listing_id', mlb).maybeSingle()
      const pid = (pl as { product_id?: string } | null)?.product_id
      if (pid) {
        const { data } = await supabaseAdmin.from('products').select(sel).eq('organization_id', orgId).eq('id', pid).maybeSingle()
        if (data) return data as ProductRow
      }
    }
    return null
  }

  // ── páreo em camadas: radar real → sintético → catálogo ────────────────────

  private async loadCandidates(orgId: string, target: ProductRow): Promise<{ candidates: Candidate[]; source: CandidateSource }> {
    // (1) Concorrentes REAIS do Radar (vínculos manuais por produto).
    const radar = await this.radarCompetitors(orgId, target.id)
    if (radar.length >= 2) return { candidates: radar.slice(0, MAX_PEERS), source: 'radar' }

    // (2) Concorrentes "típicos de mercado" gerados por IA.
    const synth = await this.syntheticCompetitors(orgId, target)
    if (synth.length >= MIN_CANDIDATES) return { candidates: [...radar, ...synth].slice(0, MAX_PEERS), source: 'synthetic' }

    // (3) Fallback: irmãos de categoria do próprio catálogo.
    const peers = await this.catalogPeers(orgId, target)
    return { candidates: [...radar, ...peers].slice(0, MAX_PEERS), source: peers.length ? 'catalog' : 'synthetic' }
  }

  private async radarCompetitors(orgId: string, productId: string): Promise<Candidate[]> {
    try {
      const { data } = await supabaseAdmin
        .from('radar_competitor_links')
        .select('competitor_title, current_price, status')
        .eq('organization_id', orgId).eq('product_id', productId)
        .not('competitor_title', 'is', null).limit(MAX_PEERS)
      return (data as Array<{ competitor_title?: string; current_price?: number; status?: string }> | null ?? [])
        .filter(r => (r.status ?? 'active') !== 'removed' && r.competitor_title)
        .map(r => ({ title: String(r.competitor_title), desc: `${r.competitor_title}${r.current_price ? ` — R$ ${r.current_price}` : ''}` }))
    } catch { return [] }
  }

  private async syntheticCompetitors(orgId: string, target: ProductRow): Promise<Candidate[]> {
    try {
      const out = await this.llm.generateText({
        orgId, feature: 'ai_visibility_rank_simulator',
        systemPrompt: 'Você modela o cenário competitivo de e-commerce. Gera descrições curtas de produtos CONCORRENTES TÍPICOS (de outras marcas, genéricos) que disputariam o mesmo comprador. Responda só JSON.',
        userPrompt: `Produto de referência: ${target.name}\nCategoria: ${target.category}\nAtributos: ${this.attrsText(target.attributes)}\n\n` +
          `Gere 5 concorrentes TÍPICOS de mercado pra essa categoria (outras marcas, NÃO use "Vazzo"). ` +
          `Varie o posicionamento: alguns básicos/baratos, alguns premium, alguns com descrição fraca e outros com descrição rica. ` +
          `Cada um: título curto + 1-2 frases de descrição realista. Responda JSON: {"competitors":[{"title":"...","desc":"..."}]}`,
        jsonMode: true, maxTokens: 700, temperature: 0.8,
      })
      const obj = JSON.parse(out.text.replace(/```json/gi, '').replace(/```/g, '').trim()) as { competitors?: unknown }
      const arr = Array.isArray(obj.competitors) ? obj.competitors : []
      return arr.map((c: Record<string, unknown>) => ({ title: String(c.title ?? '').trim(), desc: String(c.desc ?? '').trim() }))
        .filter(c => c.title).slice(0, MAX_PEERS)
    } catch (e) {
      this.logger.warn(`[rank-sim] syntheticCompetitors falhou: ${(e as Error).message}`)
      return []
    }
  }

  private async catalogPeers(orgId: string, target: ProductRow): Promise<Candidate[]> {
    const { data } = await supabaseAdmin
      .from('products')
      .select('id, name, category, description, ai_short_description, ai_long_description, price, review_count, review_avg, attributes')
      .eq('organization_id', orgId).eq('category', target.category).neq('id', target.id)
      .not('name', 'is', null).order('review_count', { ascending: false, nullsFirst: false }).limit(MAX_PEERS)
    return (data as ProductRow[] | null ?? []).map(p => ({ title: p.name ?? '', desc: shortDesc(p) }))
  }

  // ── geração de queries + descrição otimizada ──────────────────────────────

  private async genQueries(orgId: string, target: ProductRow): Promise<string[]> {
    try {
      const out = await this.llm.generateText({
        orgId, feature: 'ai_visibility_rank_simulator',
        systemPrompt: 'Você gera perguntas realistas que um comprador faria a um assistente de IA (ChatGPT/Perplexity) ao procurar este tipo de produto. Linguagem natural, com intenção/contexto. Responda só JSON.',
        userPrompt: `Produto: ${target.name}\nCategoria: ${target.category}\nAtributos: ${this.attrsText(target.attributes)}\n\n` +
          `Gere ${N_QUERIES} perguntas DISTINTAS, naturais, que levariam a IA a recomendar este TIPO de produto (não cite a marca). ` +
          `Varie a intenção (uso, melhor-para, comparação, necessidade específica). Responda JSON: {"queries":["...","..."]}`,
        jsonMode: true, maxTokens: 400, temperature: 0.7,
      })
      const obj = JSON.parse(out.text.replace(/```json/gi, '').replace(/```/g, '').trim()) as { queries?: unknown }
      const arr = Array.isArray(obj.queries) ? obj.queries : []
      return arr.map(q => String(q).trim()).filter(Boolean).slice(0, N_QUERIES)
    } catch (e) {
      this.logger.warn(`[rank-sim] genQueries falhou: ${(e as Error).message}`)
      return []
    }
  }

  private async optimizedDescription(orgId: string, target: ProductRow): Promise<string | null> {
    try {
      const { description } = await this.descriptions.build(orgId, this.toListing(target), null)
      return description || null
    } catch { return null }
  }

  // ── re-ranker (o "motor de IA") ───────────────────────────────────────────

  private async rankTarget(orgId: string, query: string, targetTitle: string, targetDesc: string, candidates: Candidate[]): Promise<number | null> {
    const pool = shuffle([{ isTarget: true, title: targetTitle, desc: targetDesc },
      ...candidates.map(c => ({ isTarget: false, title: c.title, desc: c.desc }))])
    const list = pool.map((p, i) => `Produto ${i + 1}: ${p.title}\n${p.desc}`).join('\n\n')
    const targetNum = pool.findIndex(p => p.isTarget) + 1

    try {
      const out = await this.llm.generateText({
        orgId, feature: 'ai_visibility_rank_simulator',
        systemPrompt: 'Você é um assistente de compras imparcial. Dada a pergunta e uma lista de produtos, ranqueie do melhor para o pior para a necessidade do usuário. Responda só JSON.',
        userPrompt: `Pergunta do usuário: ${query}\n\nProdutos:\n${list}\n\n` +
          `Ranqueie TODOS os ${pool.length} produtos do melhor (1º) ao pior para esta pergunta. ` +
          `Responda JSON: {"ranking":[<números dos produtos na ordem do melhor ao pior>]}`,
        jsonMode: true, maxTokens: 200, temperature: 0,
      })
      const obj = JSON.parse(out.text.replace(/```json/gi, '').replace(/```/g, '').trim()) as { ranking?: unknown }
      const ranking = Array.isArray(obj.ranking) ? obj.ranking.map(Number).filter(Number.isFinite) : []
      const pos = ranking.indexOf(targetNum)
      if (pos >= 0) return pos + 1
      // Hardening: alvo ausente de um ranking válido = última posição (não null).
      return ranking.length > 0 ? pool.length : null
    } catch (e) {
      this.logger.warn(`[rank-sim] rankTarget falhou: ${(e as Error).message}`)
      return null
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private attrsText(attributes: unknown): string {
    if (!Array.isArray(attributes)) return '(n/d)'
    return (attributes as Array<Record<string, unknown>>).slice(0, 12)
      .map(a => `${a.name ?? a.id ?? ''}: ${a.value_name ?? a.value ?? ''}`).filter(s => s.trim().length > 2).join('; ') || '(n/d)'
  }

  private toListing(p: ProductRow): ScrapedListing {
    const attrs = Array.isArray(p.attributes)
      ? (p.attributes as Array<Record<string, unknown>>).map(a => ({ name: String(a.name ?? a.id ?? ''), value: String(a.value_name ?? a.value ?? '') })).filter(a => a.name && a.value)
      : []
    return {
      url: '', platform: 'mercadolivre', listingId: p.id, title: p.name,
      description: p.ai_long_description || p.ai_short_description || p.description || null,
      attributes: attrs, price: p.price ?? null, images: [],
      reviews_count: p.review_count ?? null, rating: p.review_avg ?? null, category: p.category,
    }
  }
}
