import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../../../common/supabase'
import { LlmService } from '../../../ai/llm.service'
import { GeoTelemetryService } from '../../geo-score/services/geo-telemetry.service'
import { DescriptionBuilderService } from './description-builder.service'
import { ScrapedListing } from '../../shared/types'

/**
 * GEO Rank Simulator (método do E-GEO, arXiv 2511.20867 — ver [[geo-papers]]).
 * Simula o motor de IA como RE-RANKER: gera queries realistas de comprador,
 * monta um páreo (produto-alvo + concorrentes da mesma categoria) e pede a um
 * LLM pra ranquear — medindo a POSIÇÃO do produto. Roda com a descrição ATUAL
 * e com a OTIMIZADA → delta de posição. Métrica direta de visibilidade em IA,
 * sem depender de crawl real. 100% leitura do catálogo (não publica nada).
 */

const N_QUERIES = 4
const MAX_PEERS = 6

export interface SimQueryResult { query: string; rank_before: number | null; rank_after: number | null }
export interface RankSimReport {
  product_id:       string | null
  title:            string
  category:         string | null
  candidate_count:  number
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

    const empty = (note: string): RankSimReport => ({
      product_id: target.id, title: target.name ?? '(sem título)', category: target.category,
      candidate_count: 0, queries: [], avg_rank_before: null, avg_rank_after: null, rank_delta: null, optimized: false, note,
    })
    if (!target.category) return empty('no_category')

    const peers = await this.loadPeers(orgId, target)
    if (peers.length < 1) return empty('insufficient_peers')

    // 1) Queries realistas de comprador + 2) descrição otimizada (em paralelo).
    const [queries, optimized] = await Promise.all([
      this.genQueries(orgId, target),
      this.optimizedDescription(orgId, target),
    ])
    if (queries.length === 0) return empty('query_gen_failed')

    const beforeDesc = shortDesc(target, 600) || target.name || ''
    const afterDesc  = (optimized || beforeDesc).slice(0, 600)

    const results: SimQueryResult[] = []
    for (const q of queries) {
      const [rb, ra] = await Promise.all([
        this.rankTarget(orgId, q, target, beforeDesc, peers),
        this.rankTarget(orgId, q, target, afterDesc, peers),
      ])
      results.push({ query: q, rank_before: rb, rank_after: ra })
    }

    const before = results.map(r => r.rank_before).filter((n): n is number => n != null)
    const after  = results.map(r => r.rank_after).filter((n): n is number => n != null)
    const avgB = before.length ? +(before.reduce((s, n) => s + n, 0) / before.length).toFixed(2) : null
    const avgA = after.length ? +(after.reduce((s, n) => s + n, 0) / after.length).toFixed(2) : null
    const delta = (avgB != null && avgA != null) ? +(avgB - avgA).toFixed(2) : null

    const report: RankSimReport = {
      product_id: target.id, title: target.name ?? '(sem título)', category: target.category,
      candidate_count: peers.length + 1, queries: results,
      avg_rank_before: avgB, avg_rank_after: avgA, rank_delta: delta, optimized: !!optimized, note: null,
    }
    await this.telemetry.emit({
      orgId, userId: userId ?? '', jobId: 'rank_sim', feature: 'geo_optimizer',
      eventName: 'geo_optimizer.rank_simulated',
      properties: { product_id: target.id, candidates: peers.length + 1, avg_before: avgB, avg_after: avgA, delta },
    }).catch(() => {})
    this.logger.log(`[rank-sim] org=${orgId} prod=${target.id} antes=${avgB} depois=${avgA} delta=${delta} (n=${peers.length + 1})`)
    return report
  }

  // ── resolução de alvo + peers ─────────────────────────────────────────────

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

  private async loadPeers(orgId: string, target: ProductRow): Promise<ProductRow[]> {
    const { data } = await supabaseAdmin
      .from('products')
      .select('id, name, category, description, ai_short_description, ai_long_description, price, review_count, review_avg, attributes')
      .eq('organization_id', orgId).eq('category', target.category).neq('id', target.id)
      .not('name', 'is', null)
      .order('review_count', { ascending: false, nullsFirst: false })
      .limit(MAX_PEERS)
    return (data as ProductRow[] | null ?? [])
  }

  // ── geração de queries + descrição otimizada ──────────────────────────────

  private async genQueries(orgId: string, target: ProductRow): Promise<string[]> {
    const attrs = this.attrsText(target.attributes)
    try {
      const out = await this.llm.generateText({
        orgId, feature: 'ai_visibility_rank_simulator',
        systemPrompt: 'Você gera perguntas realistas que um comprador faria a um assistente de IA (ChatGPT/Perplexity) ao procurar este tipo de produto. Linguagem natural, com intenção/contexto. Responda só JSON.',
        userPrompt: `Produto: ${target.name}\nCategoria: ${target.category}\nAtributos: ${attrs}\n\n` +
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
    const listing = this.toListing(target)
    try {
      const { description } = await this.descriptions.build(orgId, listing, null)
      return description || null
    } catch { return null }
  }

  // ── re-ranker (o "motor de IA") ───────────────────────────────────────────

  private async rankTarget(orgId: string, query: string, target: ProductRow, targetDesc: string, peers: ProductRow[]): Promise<number | null> {
    // Monta o páreo embaralhado, marcando o índice do alvo.
    const pool = shuffle([{ isTarget: true, title: target.name ?? '', desc: targetDesc },
      ...peers.map(p => ({ isTarget: false, title: p.name ?? '', desc: shortDesc(p) }))])
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
      return pos >= 0 ? pos + 1 : null
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
