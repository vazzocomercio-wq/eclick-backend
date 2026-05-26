import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { LlmService } from '../../../ai/llm.service'
import { GeoDimensionName, GeoDimensionResult, GeoScoreResult, ScrapedListing } from '../../shared/types'

interface DimensionDef {
  name:          GeoDimensionName
  weight:        number
  criteria:      string
  deterministic?: boolean
}

// Σpesos = 9.0 → nota = Σ(score×peso) / 90 × 100 (0-100).
// Critérios refinados com base na literatura GEO (ver [[geo-papers]]):
// dados/estatísticas e evidência externa pesam mais; keyword stuffing NÃO pontua.
const DIMENSIONS: DimensionDef[] = [
  { name: 'title_geo',           weight: 1.5, criteria: 'O título alinha com a INTENÇÃO de busca do comprador e inclui o termo mais relevante (por relevância, NÃO por empilhamento de keywords) + 1 diferencial concreto, em linguagem natural e tamanho adequado?' },
  { name: 'description_depth',   weight: 1.5, criteria: 'A descrição traz DADOS e NÚMEROS concretos (estatísticas, medidas, specs quantitativas — não só adjetivos), bem estruturada e fácil de a IA extrair/citar? Conteúdo data-dense vale mais que tamanho puro.' },
  { name: 'entity_coverage',     weight: 1.0, criteria: 'A marca está explícita, a categoria preenchida e há 5+ atributos concretos (entidades que a IA relaciona à busca)?' },
  { name: 'semantic_density',    weight: 1.0, criteria: 'Há VARIEDADE de vocabulário, sinônimos e contextos que a IA relaciona a várias buscas? IMPORTANTE: repetir a mesma palavra-chave pra "encher" (keyword stuffing) NÃO pontua e pode indicar spam.' },
  { name: 'structured_data',     weight: 1.0, criteria: 'Os dados estruturados estão completos (schema.org Product/Offer/AggregateRating/FAQPage se for site; todos os atributos do marketplace preenchidos)?' },
  { name: 'review_architecture', weight: 1.5, criteria: 'Há evidência de credibilidade que a IA cita como confiança — avaliações (quantidade, profundidade, distribuição de estrelas) e/ou prova externa (certificações, dados de terceiros)?' },
  { name: 'faq_presence',        weight: 1.0, criteria: 'Existe FAQ ou perguntas reais de compra respondidas com fatos no listing?' },
  { name: 'crawler_access',      weight: 0.5, criteria: 'O robots.txt permite os bots de IA (OAI-SearchBot, ClaudeBot, PerplexityBot)?', deterministic: true },
]

const WEIGHT_SUM = DIMENSIONS.reduce((s, d) => s + d.weight, 0) // 9.0
const AI_BOTS = ['OAI-SearchBot', 'ClaudeBot', 'PerplexityBot']

const SYSTEM_PROMPT =
  'Você é um auditor especialista em GEO (Generative Engine Optimization) — otimização de ' +
  'conteúdo para ser encontrado e citado por IAs generativas (ChatGPT, Perplexity, Gemini). ' +
  'Analise APENAS a dimensão pedida do listing e dê uma nota de 0 a 10. Responda somente JSON.'

@Injectable()
export class GeoScoreCalculatorService {
  private readonly logger = new Logger(GeoScoreCalculatorService.name)

  constructor(private readonly llm: LlmService) {}

  async calculate(orgId: string, listing: ScrapedListing): Promise<GeoScoreResult> {
    const context = this.buildContext(listing)

    const results = await Promise.all(
      DIMENSIONS.map(d =>
        d.deterministic ? this.scoreCrawlerAccess(d, listing.url) : this.scoreWithLlm(orgId, d, context),
      ),
    )

    const dimensions = results.map(r => r.dim)
    const costUsd    = results.reduce((s, r) => s + r.cost, 0)
    const weighted   = dimensions.reduce((s, d) => s + d.score * d.weight, 0)
    const geoScore   = Math.round((weighted / (10 * WEIGHT_SUM)) * 100)

    return { geoScore, dimensions, costUsd }
  }

  // ── Dimensão via LLM ────────────────────────────────────────────────────

  private async scoreWithLlm(orgId: string, def: DimensionDef, context: string): Promise<{ dim: GeoDimensionResult; cost: number }> {
    const userPrompt =
      `Dimensão: ${def.name}\nCritérios: ${def.criteria}\n\n` +
      `Listing:\n${context}\n\n` +
      'Responda JSON: {"score": 0-10, "reasoning": "explicação em 1-2 frases", "evidence": "trecho do listing que justifica"}'

    try {
      const out = await this.llm.generateText({
        orgId,
        feature:    'ai_visibility_geo_score',
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        jsonMode:   true,
        maxTokens:  300,
        temperature: 0,
      })
      const parsed = this.parseScore(out.text)
      return {
        dim: { name: def.name, weight: def.weight, score: parsed.score, reasoning: parsed.reasoning, evidence: parsed.evidence },
        cost: out.costUsd,
      }
    } catch (e) {
      this.logger.warn(`[geo-score] dimensão ${def.name} falhou: ${(e as Error).message}`)
      return {
        dim: { name: def.name, weight: def.weight, score: 0, reasoning: 'Falha ao avaliar (erro de IA)', evidence: '' },
        cost: 0,
      }
    }
  }

  private parseScore(text: string): { score: number; reasoning: string; evidence: string } {
    try {
      const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
      const obj = JSON.parse(cleaned) as { score?: unknown; reasoning?: unknown; evidence?: unknown }
      const n = Number(obj.score)
      return {
        score:     Math.max(0, Math.min(10, Number.isFinite(n) ? n : 0)),
        reasoning: String(obj.reasoning ?? '').slice(0, 400),
        evidence:  String(obj.evidence ?? '').slice(0, 400),
      }
    } catch {
      return { score: 0, reasoning: 'Resposta da IA não veio em JSON válido', evidence: '' }
    }
  }

  // ── Dimensão determinística: crawler_access (robots.txt) ──────────────────

  private async scoreCrawlerAccess(def: DimensionDef, url: string): Promise<{ dim: GeoDimensionResult; cost: number }> {
    let robots = ''
    let fetched = false
    try {
      const origin = new URL(url).origin
      const { data } = await axios.get(`${origin}/robots.txt`, { timeout: 8_000, responseType: 'text' })
      robots = typeof data === 'string' ? data : String(data)
      fetched = true
    } catch { /* sem robots.txt → assume aberto */ }

    if (!fetched || !robots.trim()) {
      return {
        dim: { name: def.name, weight: def.weight, score: 10, reasoning: 'robots.txt ausente/inacessível — bots de IA assumidos como permitidos.', evidence: '' },
        cost: 0,
      }
    }

    const blocked = AI_BOTS.filter(b => this.isBotBlocked(robots, b))
    const allowed = AI_BOTS.length - blocked.length
    const score   = Math.round((allowed / AI_BOTS.length) * 10)
    const reasoning = blocked.length === 0
      ? `Todos os bots de IA (${AI_BOTS.join(', ')}) têm acesso liberado no robots.txt.`
      : `${blocked.length}/${AI_BOTS.length} bots de IA bloqueados no robots.txt: ${blocked.join(', ')}.`

    return {
      dim: { name: def.name, weight: def.weight, score, reasoning, evidence: blocked.length ? `Disallow: / para ${blocked.join(', ')}` : '' },
      cost: 0,
    }
  }

  /** Heurística: o bot está bloqueado da raiz? Casa o grupo do bot (ou '*'). */
  private isBotBlocked(robots: string, bot: string): boolean {
    const lines = robots.split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean)
    const groups: Array<{ agents: string[]; disallows: string[] }> = []
    let cur: { agents: string[]; disallows: string[] } | null = null
    let lastWasAgent = false
    for (const line of lines) {
      const idx = line.indexOf(':')
      if (idx < 0) continue
      const key = line.slice(0, idx).toLowerCase().trim()
      const val = line.slice(idx + 1).trim()
      if (key === 'user-agent') {
        if (!lastWasAgent || !cur) { cur = { agents: [], disallows: [] }; groups.push(cur) }
        cur.agents.push(val.toLowerCase())
        lastWasAgent = true
      } else if (key === 'disallow' && cur) {
        cur.disallows.push(val)
        lastWasAgent = false
      } else {
        lastWasAgent = false
      }
    }
    const botLc = bot.toLowerCase()
    const grp = groups.find(g => g.agents.includes(botLc)) ?? groups.find(g => g.agents.includes('*'))
    if (!grp) return false
    return grp.disallows.some(d => d === '/')
  }

  // ── Contexto do listing pro prompt (capado pra controlar custo) ───────────

  private buildContext(l: ScrapedListing): string {
    const attrs = l.attributes.slice(0, 30).map(a => `${a.name}: ${a.value}`).join('; ') || '(nenhum)'
    const desc  = (l.description ?? '(sem descrição)').slice(0, 2500)
    return [
      `Plataforma: ${l.platform}`,
      `Título: ${l.title ?? '(sem título)'}`,
      `Categoria: ${l.category ?? '(não informada)'}`,
      `Preço: ${l.price ?? '(não informado)'}`,
      `Atributos (${l.attributes.length}): ${attrs}`,
      `Reviews: ${l.reviews_count ?? 0} | Nota média: ${l.rating ?? 'n/d'}`,
      `Descrição (${(l.description ?? '').length} chars): ${desc}`,
    ].join('\n')
  }
}
