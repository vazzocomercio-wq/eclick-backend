import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'

/**
 * Product OS / Farm — "de que PRODUTO é o job que a impressora está rodando?"
 *
 * A telemetria da Bambu só traz o nome do arquivo (subtask_name). Quando o job veio de uma
 * ordem de produção, o produto é conhecido. Quando foi mandado pelo Bambu Studio direto,
 * casamos o nome do arquivo com um produto do Product OS em 3 camadas, nessa ordem:
 *   1. regra — tokens do nome do arquivo contra nome/código/peças dos produtos (vencedor claro);
 *   2. IA    — quando a regra empata ou não acha (1 chamada barata, resultado fica gravado);
 *   3. manual — o operador corrige no detalhe da máquina (vale pra sempre pra aquele arquivo).
 * O resultado fica em farm_job_product_match (por org + nome normalizado).
 *
 * Imagem do produto (pedido do cliente): foto REAL do anúncio quando existir; senão o RENDER
 * da versão; senão a imagem de referência.
 */

export type JobProductSource = 'op' | 'regra' | 'ia' | 'manual'
export interface JobProduct {
  product_dev_id: string | null
  name: string | null
  image_url: string | null
  image_kind: 'foto' | 'render' | 'referencia' | null
  source: JobProductSource | null
  confidence: number | null
}

interface DevLite {
  id: string; name: string; code: string | null; product_id: string | null
  photo: string | null; render: string | null; reference: string | null
  parts: string[]; tokens: Set<string>
}
interface MatchRow { job_key: string; product_dev_id: string | null; source: JobProductSource; confidence: number | null; updated_at: string }

// palavras que não identificam produto: extensões, cores, materiais, tamanhos, partes genéricas
const STOP = new Set(['stl', 'gcode', '3mf', 'plate', 'bandeja', 'corpo', 'aro', 'topo', 'base', 'tampa', 'colada', 'colado', 'com', 'sem', 'logo', 'brim', 'print', 'pronto', 'final', 'mini', 'kit', 'peca', 'pecas', 'parte',
  'areia', 'bege', 'marrom', 'champagne', 'branco', 'branca', 'preto', 'preta', 'cinza', 'rosa', 'pink', 'azul', 'verde', 'vermelho', 'amarelo', 'dourado', 'prata', 'grafite', 'creme', 'nude', 'off', 'white', 'osso', 'silk', 'matte', 'fosco', 'petg', 'pla', 'abs', 'vazzo', 'nature', 'mineral'])

function norm(s: string): string { return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') }
function tokensOf(s: string): string[] {
  return norm(s).replace(/\.(gcode\.)?3mf/g, ' ').replace(/\.stl/g, ' ').split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t))
}
/** Nome do job normalizado — é a chave de cache (o mesmo arquivo mandado de novo cai na mesma linha). */
export function jobKey(job: string): string { return norm(job).replace(/\.(gcode\.)?3mf/g, '').replace(/\.stl/g, '').replace(/\s+/g, ' ').trim().slice(0, 300) }

function parseJsonLoose(text: string): unknown {
  const t = (text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try { return JSON.parse(t) } catch { /* tenta recortar o objeto */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}')
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)) } catch { /* */ } }
  return null
}

const CATALOG_TTL_MS = 60_000
const RETRY_UNKNOWN_MS = 24 * 3600_000   // job não identificado: só tenta a IA de novo depois de 1 dia
const MAX_LLM_PER_CALL = 2               // o status é consultado a cada 5 s; não segurar a resposta com muitas chamadas

@Injectable()
export class FarmJobImageService {
  private readonly logger = new Logger(FarmJobImageService.name)
  private catalog = new Map<string, { at: number; devs: DevLite[] }>()
  private inflight = new Set<string>()   // org:key sendo resolvido pela IA agora

  constructor(private readonly llm: LlmService) {}

  // ── catálogo leve (cache 60 s) ───────────────────────────────────────
  private async devs(orgId: string): Promise<DevLite[]> {
    const c = this.catalog.get(orgId)
    if (c && Date.now() - c.at < CATALOG_TTL_MS) return c.devs
    const [{ data: devs }, { data: parts }, { data: vers }] = await Promise.all([
      supabaseAdmin.from('product_dev').select('id, name, code, product_id, reference_images, status').eq('organization_id', orgId).neq('status', 'arquivado'),
      supabaseAdmin.from('product_dev_part').select('product_dev_id, name').eq('organization_id', orgId),
      supabaseAdmin.from('product_dev_version').select('product_dev_id, thumbnail_url, created_at').eq('organization_id', orgId).not('thumbnail_url', 'is', null).order('created_at', { ascending: false }),
    ])
    const productIds = [...new Set(((devs ?? []) as Array<{ product_id: string | null }>).map(d => d.product_id).filter((x): x is string => !!x))]
    const { data: prods } = productIds.length ? await supabaseAdmin.from('products').select('id, photo_urls, images').in('id', productIds) : { data: [] as unknown[] }
    const photoByProduct = new Map<string, string | null>()
    for (const p of (prods ?? []) as Array<{ id: string; photo_urls: string[] | null; images: Array<string | { url?: string }> | null }>) {
      const first = p.photo_urls?.[0] ?? (typeof p.images?.[0] === 'string' ? p.images[0] as string : (p.images?.[0] as { url?: string } | undefined)?.url) ?? null
      photoByProduct.set(p.id, first)
    }
    const partsByDev = new Map<string, string[]>()
    for (const p of (parts ?? []) as Array<{ product_dev_id: string; name: string }>) partsByDev.set(p.product_dev_id, [...(partsByDev.get(p.product_dev_id) ?? []), p.name])
    const renderByDev = new Map<string, string>()
    for (const v of (vers ?? []) as Array<{ product_dev_id: string; thumbnail_url: string }>) if (!renderByDev.has(v.product_dev_id)) renderByDev.set(v.product_dev_id, v.thumbnail_url)
    const out: DevLite[] = ((devs ?? []) as Array<{ id: string; name: string; code: string | null; product_id: string | null; reference_images: Array<{ url?: string }> | null }>).map(d => {
      const partNames = partsByDev.get(d.id) ?? []
      return {
        id: d.id, name: d.name, code: d.code, product_id: d.product_id,
        photo: d.product_id ? photoByProduct.get(d.product_id) ?? null : null,
        render: renderByDev.get(d.id) ?? null,
        reference: d.reference_images?.[0]?.url ?? null,
        parts: partNames,
        tokens: new Set([...tokensOf(d.name), ...(d.code ? tokensOf(d.code) : []), ...partNames.flatMap(tokensOf)]),
      }
    })
    this.catalog.set(orgId, { at: Date.now(), devs: out })
    return out
  }

  private image(d: DevLite | undefined): Pick<JobProduct, 'image_url' | 'image_kind'> {
    if (!d) return { image_url: null, image_kind: null }
    if (d.photo) return { image_url: d.photo, image_kind: 'foto' }
    if (d.render) return { image_url: d.render, image_kind: 'render' }
    if (d.reference) return { image_url: d.reference, image_kind: 'referencia' }
    return { image_url: null, image_kind: null }
  }

  /** Produto conhecido (veio da OP) → só resolve a imagem. */
  async forDev(orgId: string, devId: string): Promise<JobProduct> {
    const d = (await this.devs(orgId)).find(x => x.id === devId)
    return { product_dev_id: devId, name: d?.name ?? null, ...this.image(d), source: 'op', confidence: 1 }
  }

  /** Vários jobs de uma vez (uma consulta ao cache de matches; no máximo 2 chamadas de IA por rodada). */
  async forJobs(orgId: string, jobNames: string[]): Promise<Map<string, JobProduct>> {
    const result = new Map<string, JobProduct>()
    const names = [...new Set(jobNames.filter(Boolean))]
    if (!names.length) return result
    const devs = await this.devs(orgId)
    const byId = new Map(devs.map(d => [d.id, d]))
    const keys = names.map(jobKey)
    const { data: rows } = await supabaseAdmin.from('farm_job_product_match').select('job_key, product_dev_id, source, confidence, updated_at').eq('organization_id', orgId).in('job_key', keys)
    const rowByKey = new Map(((rows ?? []) as MatchRow[]).map(r => [r.job_key, r]))
    let llmBudget = MAX_LLM_PER_CALL
    for (const name of names) {
      const key = jobKey(name)
      const row = rowByKey.get(key)
      if (row && (row.product_dev_id || row.source === 'manual' || Date.now() - new Date(row.updated_at).getTime() < RETRY_UNKNOWN_MS)) {
        const d = row.product_dev_id ? byId.get(row.product_dev_id) : undefined
        result.set(name, { product_dev_id: row.product_dev_id, name: d?.name ?? null, ...this.image(d), source: row.source, confidence: row.confidence })
        continue
      }
      // 1) regra
      const rule = this.byRule(name, devs)
      if (rule) { result.set(name, rule); void this.save(orgId, key, name, rule); continue }
      // 2) IA (limitada por rodada; o que sobrar resolve no próximo poll)
      const tag = `${orgId}:${key}`
      if (llmBudget > 0 && !this.inflight.has(tag)) {
        llmBudget--; this.inflight.add(tag)
        try {
          const ai = await this.byAi(orgId, name, devs)
          result.set(name, ai); await this.save(orgId, key, name, ai)
        } catch (e) { this.logger.warn(`[farm.job-image] IA falhou para "${name}": ${e instanceof Error ? e.message : e}`); result.set(name, this.empty()) }
        finally { this.inflight.delete(tag) }
      } else result.set(name, this.empty())
    }
    return result
  }

  /** Ajuste manual do operador: este arquivo é deste produto (ou de nenhum). */
  async setManual(orgId: string, jobName: string, productDevId: string | null): Promise<JobProduct> {
    const key = jobKey(jobName)
    if (productDevId) {
      const { data: ok } = await supabaseAdmin.from('product_dev').select('id').eq('id', productDevId).eq('organization_id', orgId).maybeSingle()
      if (!ok) throw new Error('Produto não encontrado nesta organização')
    }
    const jp: JobProduct = { product_dev_id: productDevId, name: null, image_url: null, image_kind: null, source: 'manual', confidence: 1 }
    await this.save(orgId, key, jobName, jp)
    const d = productDevId ? (await this.devs(orgId)).find(x => x.id === productDevId) : undefined
    return { ...jp, name: d?.name ?? null, ...this.image(d) }
  }

  private empty(): JobProduct { return { product_dev_id: null, name: null, image_url: null, image_kind: null, source: null, confidence: null } }

  private async save(orgId: string, key: string, jobName: string, jp: JobProduct) {
    const { error } = await supabaseAdmin.from('farm_job_product_match').upsert({
      organization_id: orgId, job_key: key, job_name: jobName.slice(0, 500), product_dev_id: jp.product_dev_id,
      source: jp.source ?? 'ia', confidence: jp.confidence, updated_at: new Date().toISOString(),
    }, { onConflict: 'organization_id,job_key' })
    if (error) this.logger.warn(`[farm.job-image] upsert: ${error.message}`)
  }

  /** Regra: tokens do arquivo contra tokens do produto (nome + código + peças). Só aceita vencedor claro. */
  private byRule(jobName: string, devs: DevLite[]): JobProduct | null {
    const jt = tokensOf(jobName)
    if (!jt.length) return null
    const scored = devs.map(d => {
      let s = 0
      for (const t of jt) { if (d.tokens.has(t)) s += 1; else if ([...d.tokens].some(x => x.startsWith(t) || t.startsWith(x))) s += 0.5 }
      return { d, s }
    }).sort((a, b) => b.s - a.s)
    const [best, second] = scored
    if (!best || best.s < 1) return null
    if (second && best.s < second.s + 1) return null   // empate → IA decide
    // só aceita quando TODOS os tokens do arquivo batem exatamente no produto (bandeja com
    // peças de produtos diferentes, ou nome parcial, vai pra IA — errar imagem é pior que esperar)
    const full = jt.every(t => best.d.tokens.has(t))
    if (!full) return null
    const confidence = Math.min(0.9, 0.6 + 0.1 * best.s)
    return { product_dev_id: best.d.id, name: best.d.name, ...this.image(best.d), source: 'regra', confidence }
  }

  /** IA: escolhe entre os produtos (lista curta e barata). */
  private async byAi(orgId: string, jobName: string, devs: DevLite[]): Promise<JobProduct> {
    const jt = new Set(tokensOf(jobName))
    // candidatos: quem compartilha algum token; se ninguém, a lista inteira (limitada)
    let cands = devs.filter(d => [...jt].some(t => d.tokens.has(t) || [...d.tokens].some(x => x.startsWith(t) || t.startsWith(x))))
    if (!cands.length) cands = devs.slice(0, 150)
    const lista = cands.map(d => `${d.id} | ${d.name}${d.code ? ` (${d.code})` : ''}${d.parts.length ? ` | peças: ${d.parts.slice(0, 8).join(', ')}` : ''}`).join('\n')
    const out = await this.llm.generateText({
      // modelos de raciocínio gastam tokens de saída "pensando": 200 estourava e a resposta vinha vazia
      orgId, feature: 'farm_job_product_match', jsonMode: true, maxTokens: 3000,
      systemPrompt: 'Você identifica a qual produto de uma fábrica de impressão 3D pertence um arquivo que está sendo impresso. O nome do arquivo vem do fatiador e costuma trazer nome da peça, cor e tamanho; uma bandeja pode juntar várias peças (separadas por " + ") — nesse caso escolha o produto principal. Responda SOMENTE JSON: {"product_dev_id": "<id ou null>", "confidence": 0.0-1.0}. Use null quando nenhum produto da lista for claramente o certo.',
      userPrompt: `Arquivo em impressão: "${jobName}"\n\nProdutos (id | nome | peças):\n${lista}`,
    })
    const parsed = parseJsonLoose(out.text) as { product_dev_id?: string | null; confidence?: number } | null
    if (!parsed || typeof parsed !== 'object') throw new Error(`resposta da IA sem JSON (${(out.text || '').slice(0, 80) || 'vazia'})`)   // falha → NÃO grava; tenta de novo na próxima rodada
    const id = parsed?.product_dev_id && cands.some(c => c.id === parsed.product_dev_id) ? parsed.product_dev_id : null
    const d = id ? cands.find(c => c.id === id) : undefined
    const confidence = typeof parsed?.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : (id ? 0.5 : 0)
    return { product_dev_id: id, name: d?.name ?? null, ...this.image(d), source: 'ia', confidence }
  }
}
