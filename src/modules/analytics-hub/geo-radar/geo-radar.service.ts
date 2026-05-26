import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { LlmService } from '../../ai/llm.service'
import { CredentialsService } from '../../credentials/credentials.service'

// Custos estimados por chamada com busca web (aproximados — billing varia).
const COST = { gemini: 0.012, openai: 0.04, claude: 0.02 } as const
export type RadarEngine = keyof typeof COST
const ALL_ENGINES: RadarEngine[] = ['gemini', 'openai', 'claude']
const DEFAULT_MAX_QUERIES = 15
const DEFAULT_MAX_COST = 3.0

interface EngineResult {
  text: string
  citations: { url: string; title: string }[]
  cost: number
  error?: string
}

export interface RadarRunSummary {
  queries: number
  engines: RadarEngine[]
  runs: number
  mentioned: number
  by_engine: Record<string, { runs: number; mentioned: number }>
  cost_usd: number
  errors: string[]
}

/**
 * GEO Radar — mede a presença/citação da marca nas respostas dos motores de IA
 * (Gemini grounding, OpenAI web search, Claude web search) para queries de
 * comprador. Share-of-voice em IA. Custa créditos por (query × motor).
 */
@Injectable()
export class GeoRadarService {
  private readonly logger = new Logger(GeoRadarService.name)

  constructor(
    private readonly llm: LlmService,
    private readonly credentials: CredentialsService,
  ) {}

  // ── Semeação ──────────────────────────────────────────────────────────────

  /** Gera ~N queries de comprador a partir do catálogo → tracked_queries.
   *  Semeia tracked_products com as marcas próprias (alvos de detecção). */
  async seed(orgId: string, count = DEFAULT_MAX_QUERIES): Promise<{ queries: number; products: number }> {
    // marcas próprias → tracked_products (o que detectar)
    const { data: brandRows } = await supabaseAdmin
      .from('products').select('brand').eq('organization_id', orgId).not('brand', 'is', null).limit(500)
    const brands = [...new Set((brandRows ?? []).map((r: { brand: string }) => r.brand).filter(Boolean))].slice(0, 5)
    let products = 0
    for (const b of brands) {
      const { data: exists } = await supabaseAdmin
        .from('tracked_products').select('id').eq('org_id', orgId).eq('label', b).limit(1)
      if (exists && exists.length) continue
      const { error } = await supabaseAdmin.from('tracked_products').insert({ org_id: orgId, label: b, active: true })
      if (!error) products++
    }

    // queries de comprador a partir dos nomes do catálogo
    const { data: prods } = await supabaseAdmin
      .from('products').select('name, category').eq('organization_id', orgId).not('name', 'is', null)
      .order('updated_at', { ascending: false }).limit(40)
    const sample = (prods ?? []).map((p: { name: string }) => p.name).slice(0, 40).join('\n')

    let queries = 0
    try {
      const out = await this.llm.generateText({
        orgId, feature: 'ai_visibility_rank_simulator',
        systemPrompt: 'Você gera buscas REAIS de compradores brasileiros para assistentes de IA (ChatGPT/Gemini/Perplexity). Responda só JSON.',
        userPrompt:
          `Produtos da loja:\n${sample}\n\n` +
          `Gere ${count} perguntas/buscas naturais que um comprador faria a uma IA antes de comprar produtos DESSE tipo ` +
          `(ex: "melhor plafon de LED 3 temperaturas pra sala", "arandela de cristal vale a pena?"). ` +
          `NÃO cite marcas específicas. Variado: comparações, recomendações, dúvidas técnicas. ` +
          `JSON: {"queries":["...","..."]}`,
        jsonMode: true, maxTokens: 800, temperature: 0.8,
      })
      const obj = JSON.parse(out.text.replace(/```json/gi, '').replace(/```/g, '').trim()) as { queries?: string[] }
      const list = (Array.isArray(obj.queries) ? obj.queries : []).map((q) => String(q).trim()).filter(Boolean).slice(0, count)
      for (const q of list) {
        const { data: exists } = await supabaseAdmin
          .from('tracked_queries').select('id').eq('org_id', orgId).eq('query', q).limit(1)
        if (exists && exists.length) continue
        const { error } = await supabaseAdmin.from('tracked_queries').insert({ org_id: orgId, query: q, active: true })
        if (!error) queries++
      }
    } catch (e) {
      this.logger.warn(`[geo-radar] seed queries falhou: ${(e as Error).message}`)
    }
    return { queries, products }
  }

  // ── Runner ────────────────────────────────────────────────────────────────

  async run(orgId: string, opts?: { maxQueries?: number; engines?: RadarEngine[]; maxCostUsd?: number }): Promise<RadarRunSummary> {
    const engines = opts?.engines ?? ALL_ENGINES
    const maxQueries = opts?.maxQueries ?? DEFAULT_MAX_QUERIES
    const maxCost = opts?.maxCostUsd ?? DEFAULT_MAX_COST
    const summary: RadarRunSummary = {
      queries: 0, engines, runs: 0, mentioned: 0,
      by_engine: Object.fromEntries(engines.map((e) => [e, { runs: 0, mentioned: 0 }])),
      cost_usd: 0, errors: [],
    }

    const targets = await this.detectionTargets(orgId)
    if (targets.terms.length === 0) { summary.errors.push('Sem alvos de detecção — rode o seed primeiro.'); return summary }

    const { data: q } = await supabaseAdmin
      .from('tracked_queries').select('id, query').eq('org_id', orgId).eq('active', true).limit(maxQueries)
    const queries = (q ?? []) as { id: string; query: string }[]
    if (queries.length === 0) { summary.errors.push('Sem queries ativas — rode o seed primeiro.'); return summary }
    summary.queries = queries.length
    const today = new Date().toISOString().slice(0, 10)

    for (const { id, query } of queries) {
      for (const engine of engines) {
        if (summary.cost_usd >= maxCost) { summary.errors.push(`Teto de custo $${maxCost} atingido`); return summary }
        let r: EngineResult
        try {
          r = await this.ask(engine, orgId, query)
        } catch (e) {
          r = { text: '', citations: [], cost: 0, error: String(e) }
        }
        summary.cost_usd += r.cost
        const det = this.detect(r, targets)
        const { error } = await supabaseAdmin.from('analytics_geo_radar_runs').upsert({
          organization_id: orgId, query_id: id, query, engine, date: today,
          mentioned: det.mentioned, brand_cited: det.brandCited, position: det.position,
          answer_excerpt: r.text.slice(0, 600), citations: r.citations.slice(0, 10),
          raw: {}, cost_usd: r.cost, error: r.error ?? null, updated_at: new Date().toISOString(),
        }, { onConflict: 'organization_id,query,engine,date' })
        if (error) summary.errors.push(`upsert ${engine}/${query.slice(0, 20)}: ${error.message}`)
        summary.runs++
        summary.by_engine[engine].runs++
        if (det.mentioned) { summary.mentioned++; summary.by_engine[engine].mentioned++ }
      }
    }
    return summary
  }

  /** Enumera orgs com queries ativas (worker cross-org). */
  async orgsWithQueries(): Promise<string[]> {
    const { data } = await supabaseAdmin.from('tracked_queries').select('org_id').eq('active', true)
    return [...new Set((data ?? []).map((r: { org_id: string }) => r.org_id))]
  }

  // ── Detecção ──────────────────────────────────────────────────────────────

  private async detectionTargets(orgId: string): Promise<{ terms: string[]; domains: string[] }> {
    const { data } = await supabaseAdmin
      .from('tracked_products').select('label, url').eq('org_id', orgId).eq('active', true)
    const terms: string[] = []
    const domains: string[] = []
    for (const r of (data ?? []) as { label: string | null; url: string | null }[]) {
      if (r.label) terms.push(r.label.toLowerCase())
      if (r.url) {
        try { domains.push(new URL(r.url).hostname.replace(/^www\./, '').toLowerCase()) } catch { /* ignora */ }
      }
    }
    return { terms: [...new Set(terms)], domains: [...new Set(domains)] }
  }

  private detect(r: EngineResult, t: { terms: string[]; domains: string[] }): { mentioned: boolean; brandCited: boolean; position: number | null } {
    const text = (r.text || '').toLowerCase()
    let position: number | null = null
    for (const term of t.terms) {
      const idx = text.indexOf(term)
      if (idx >= 0 && (position === null || idx < position)) position = idx
    }
    const mentioned = position !== null
    const citeBlob = r.citations.map((c) => `${c.url} ${c.title}`).join(' ').toLowerCase()
    const brandCited =
      t.domains.some((d) => citeBlob.includes(d)) || t.terms.some((term) => citeBlob.includes(term))
    return { mentioned, brandCited, position: mentioned ? (position as number) : null }
  }

  // ── Motores ───────────────────────────────────────────────────────────────

  private ask(engine: RadarEngine, orgId: string, query: string): Promise<EngineResult> {
    if (engine === 'gemini') return this.askGemini(query)
    if (engine === 'openai') return this.askOpenai(orgId, query)
    return this.askClaude(orgId, query)
  }

  private async key(orgId: string, provider: string, keyName: string): Promise<string | null> {
    return (await this.credentials.getDecryptedKey(orgId, provider, keyName))
      ?? (await this.credentials.getDecryptedKey(null, provider, keyName))
  }

  private async askGemini(query: string): Promise<EngineResult> {
    const key = process.env.GEMINI_API_KEY_DEFAULT ?? process.env.GEMINI_API_KEY
    if (!key) return { text: '', citations: [], cost: 0, error: 'GEMINI_API_KEY_DEFAULT ausente' }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: query }] }], tools: [{ google_search: {} }] }),
    })
    if (!res.ok) return { text: '', citations: [], cost: 0, error: `gemini ${res.status}: ${(await res.text()).slice(0, 160)}` }
    const j = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] }; groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] } }[] }
    const cand = j.candidates?.[0]
    const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('')
    const citations = (cand?.groundingMetadata?.groundingChunks ?? [])
      .map((c) => ({ url: c.web?.uri ?? '', title: c.web?.title ?? '' })).filter((c) => c.url)
    return { text, citations, cost: COST.gemini }
  }

  private async askOpenai(orgId: string, query: string): Promise<EngineResult> {
    const key = await this.key(orgId, 'openai', 'OPENAI_API_KEY')
    if (!key) return { text: '', citations: [], cost: 0, error: 'OPENAI_API_KEY ausente' }
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'gpt-4o', tools: [{ type: 'web_search_preview' }], input: query }),
    })
    if (!res.ok) return { text: '', citations: [], cost: 0, error: `openai ${res.status}: ${(await res.text()).slice(0, 160)}` }
    const j = await res.json() as { output?: { type: string; content?: { type: string; text?: string; annotations?: { type: string; url?: string; title?: string }[] }[] }[] }
    let text = ''
    const citations: { url: string; title: string }[] = []
    for (const item of j.output ?? []) {
      if (item.type !== 'message') continue
      for (const c of item.content ?? []) {
        if (c.type === 'output_text') {
          text += c.text ?? ''
          for (const a of c.annotations ?? []) if (a.type === 'url_citation' && a.url) citations.push({ url: a.url, title: a.title ?? '' })
        }
      }
    }
    return { text, citations, cost: COST.openai }
  }

  private async askClaude(orgId: string, query: string): Promise<EngineResult> {
    const key = await this.key(orgId, 'anthropic', 'ANTHROPIC_API_KEY')
    if (!key) return { text: '', citations: [], cost: 0, error: 'ANTHROPIC_API_KEY ausente' }
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 1024,
        messages: [{ role: 'user', content: query }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      }),
    })
    if (!res.ok) return { text: '', citations: [], cost: 0, error: `claude ${res.status}: ${(await res.text()).slice(0, 160)}` }
    const j = await res.json() as { content?: { type: string; text?: string; citations?: { url?: string; title?: string }[]; content?: { url?: string; title?: string }[] }[] }
    let text = ''
    const citations: { url: string; title: string }[] = []
    for (const block of j.content ?? []) {
      if (block.type === 'text') {
        text += block.text ?? ''
        for (const cit of block.citations ?? []) if (cit.url) citations.push({ url: cit.url, title: cit.title ?? '' })
      }
      if (block.type === 'web_search_tool_result') {
        for (const r of block.content ?? []) if (r.url) citations.push({ url: r.url, title: r.title ?? '' })
      }
    }
    return { text, citations, cost: COST.claude }
  }
}
