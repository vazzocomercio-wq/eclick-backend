import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'
import { BuyDecision, TrendProductRow } from './trends.types'

/** Quantos produtos (top por trend_score) recebem racional IA por rodada.
 *  Os demais ganham racional templated (sem custo de LLM). */
const AI_TOP_N = 30

interface SignalPoint { external_id: string; position: number; captured_at: string }

interface ScoreComputation {
  trend_score:      number
  momentum:         number
  volume_score:     number
  breadth_score:    number
  best_seller_rank: number | null
  rank_delta:       number | null
  persistence:      number
}

/** F-Trends Fase 1 — Trend Score determinístico + Buy Decision.
 *
 *  Trend Score (0-100) = 0.40·volume + 0.35·momentum + 0.15·breadth + 0.10·persistência
 *    • volume      — posição atual no best-seller (rank 1 = 100, decai)
 *    • momentum    — DERIVADA: subiu/caiu no ranking nos últimos 7d (+ entrante novo)
 *    • breadth     — produto casa com alguma keyword em alta (demanda cruzada)
 *    • persistência— há quantos dias é best seller (campeão consistente)
 *
 *  Buy Decision: comprar (≥65) / observar (40-65) / ignorar (<40). Margem fica
 *  "a validar" na Fase 1 (sem custo de fornecedor); a IA carimba isso no racional. */
@Injectable()
export class TrendsScoreService {
  private readonly logger = new Logger(TrendsScoreService.name)

  constructor(private readonly llm: LlmService) {}

  async scoreOrg(orgId: string): Promise<{ scored: number }> {
    // produtos candidatos
    const { data: prods } = await supabaseAdmin
      .from('trends_products')
      .select('*')
      .eq('organization_id', orgId)
      .eq('kind', 'catalog_product')
    const products = (prods ?? []) as TrendProductRow[]
    if (!products.length) return { scored: 0 }

    // série de best_seller dos últimos 8 dias (pra derivada)
    const since = new Date(Date.now() - 8 * 86400_000).toISOString()
    const { data: sigs } = await supabaseAdmin
      .from('trends_signals')
      .select('external_id, position, captured_at')
      .eq('organization_id', orgId)
      .eq('signal_type', 'best_seller')
      .gte('captured_at', since)
      .not('external_id', 'is', null)
      .order('captured_at', { ascending: true })
    const history = (sigs ?? []) as SignalPoint[]

    // keywords em alta (pra breadth) — captura mais recente
    const trendingTerms = await this.loadTrendingTerms(orgId)

    // computa score determinístico de cada produto
    const computed = products.map(p => ({
      product: p,
      comp:    this.compute(p, history, trendingTerms),
    }))
    computed.sort((a, b) => b.comp.trend_score - a.comp.trend_score)

    let scored = 0
    for (let i = 0; i < computed.length; i++) {
      const { product, comp } = computed[i]
      const decision = this.decide(comp.trend_score)
      const confidence = this.confidence(comp)

      // IA só pros top N relevantes; resto recebe racional templated
      let rationale: string
      if (i < AI_TOP_N && decision !== 'ignorar') {
        rationale = await this.aiRationale(orgId, product, comp, decision)
      } else {
        rationale = this.templateRationale(comp, decision)
      }

      await supabaseAdmin.from('trends_scores').upsert({
        organization_id:     orgId,
        product_id:          product.id,
        trend_score:         round(comp.trend_score),
        momentum:            round(comp.momentum),
        volume_score:        round(comp.volume_score),
        breadth_score:       round(comp.breadth_score),
        best_seller_rank:    comp.best_seller_rank,
        rank_delta:          comp.rank_delta,
        buy_decision:        decision,
        margin_estimate_pct: null,           // Fase 1: custo de fornecedor a validar
        confidence,
        ai_rationale:        rationale,
        components:          { ...comp },
        computed_at:         new Date().toISOString(),
      }, { onConflict: 'organization_id,product_id' })
      scored++
    }

    this.logger.log(`[trends.score] org=${orgId} scored=${scored}`)
    return { scored }
  }

  // ── cálculo determinístico ──────────────────────────────────────────────

  private compute(p: TrendProductRow, history: SignalPoint[], trendingTerms: string[]): ScoreComputation {
    const points = history
      .filter(h => h.external_id === p.external_id)
      .sort((a, b) => a.captured_at.localeCompare(b.captured_at))

    const current = points.length ? points[points.length - 1] : null
    const rank = current?.position ?? null

    // volume: rank 1 = 100; cai 4 pts por posição
    const volume_score = rank != null ? clamp(100 - (rank - 1) * 4, 0, 100) : 0

    // momentum: derivada do rank em ~7d (subir no ranking = delta positivo)
    let rank_delta: number | null = null
    let momentum = 50 // neutro quando não há histórico
    if (points.length >= 2 && rank != null) {
      const oldRank = points[0].position
      rank_delta = oldRank - rank                // subiu N posições → +N
      momentum = clamp(50 + rank_delta * 6, 0, 100)
    }
    // entrante novo bem posicionado = momentum alto
    const ageDays = (Date.now() - new Date(p.first_seen_at).getTime()) / 86400_000
    if (ageDays <= 3 && rank != null && rank <= 10) momentum = clamp(momentum + 25, 0, 100)

    // breadth: nome casa com keyword em alta?
    const nameLc = (p.name ?? '').toLowerCase()
    const matches = trendingTerms.filter(t => t.length >= 4 && nameLc.includes(t)).length
    const breadth_score = matches > 0 ? clamp(60 + matches * 20, 0, 100) : 35

    // persistência: dias como best seller (campeão consistente)
    const persistence = clamp(ageDays * 12, 0, 100)

    const trend_score =
      0.40 * volume_score +
      0.35 * momentum +
      0.15 * breadth_score +
      0.10 * persistence

    return { trend_score, momentum, volume_score, breadth_score, best_seller_rank: rank, rank_delta, persistence }
  }

  private decide(trendScore: number): BuyDecision {
    if (trendScore >= 65) return 'comprar'
    if (trendScore >= 40) return 'observar'
    return 'ignorar'
  }

  private confidence(c: ScoreComputation): number {
    // mais histórico (rank_delta calculável) = mais confiança
    let conf = c.rank_delta != null ? 0.7 : 0.45
    if (c.best_seller_rank != null && c.best_seller_rank <= 5) conf += 0.1
    return Math.min(0.95, round2(conf))
  }

  // ── racional IA (copiloto) ───────────────────────────────────────────────

  private async aiRationale(
    orgId: string, p: TrendProductRow, c: ScoreComputation, decision: BuyDecision,
  ): Promise<string> {
    const priceBrl = p.price_ref_cents != null ? (p.price_ref_cents / 100).toFixed(2) : 's/ preço'
    const sys =
      'Você é um analista de sourcing de e-commerce brasileiro. Recebe os números de tendência de ' +
      'um produto campeão de vendas no Mercado Livre e escreve uma recomendação curta e acionável ' +
      'sobre comprar para revender. Seja direto, em pt-BR, no máximo 2 frases. ' +
      'Como ainda não temos o custo do fornecedor, SEMPRE lembre que a margem precisa ser validada ' +
      'com a cotação de compra antes de fechar. Responda em JSON: {"rationale": string}.'
    const usr = JSON.stringify({
      produto: p.name, categoria: p.category_name, preco_mercado_brl: priceBrl,
      trend_score: round(c.trend_score), rank_best_seller: c.best_seller_rank,
      variacao_ranking_7d: c.rank_delta, momentum: round(c.momentum),
      demanda_busca: round(c.breadth_score), decisao_sugerida: decision,
    })
    try {
      const out = await this.llm.generateText({
        orgId, feature: 'trends_buy_decision', systemPrompt: sys, userPrompt: usr,
        maxTokens: 220, temperature: 0.4, jsonMode: true,
      })
      const parsed = JSON.parse(out.text) as { rationale?: string }
      if (parsed.rationale) return parsed.rationale
    } catch (e) {
      this.logger.warn(`[trends.score] IA racional falhou p/ ${p.external_id}: ${e instanceof Error ? e.message : e}`)
    }
    return this.templateRationale(c, decision)
  }

  private templateRationale(c: ScoreComputation, decision: BuyDecision): string {
    const rank = c.best_seller_rank != null ? `#${c.best_seller_rank} em vendas` : 'sem ranking'
    const delta = c.rank_delta == null ? 'sem histórico ainda'
      : c.rank_delta > 0 ? `subiu ${c.rank_delta} posições em 7d`
      : c.rank_delta < 0 ? `caiu ${Math.abs(c.rank_delta)} posições em 7d`
      : 'estável no ranking'
    const head = decision === 'comprar' ? 'Forte candidato'
      : decision === 'observar' ? 'Vale acompanhar' : 'Sinal fraco'
    return `${head}: ${rank}, ${delta}. Valide o custo do fornecedor antes de fechar a compra.`
  }

  private async loadTrendingTerms(orgId: string): Promise<string[]> {
    const { data } = await supabaseAdmin
      .from('trends_signals')
      .select('term, captured_at')
      .eq('organization_id', orgId)
      .eq('signal_type', 'search_trend')
      .not('term', 'is', null)
      .order('captured_at', { ascending: false })
      .limit(300)
    const seen = new Set<string>()
    for (const r of (data ?? []) as { term: string }[]) {
      if (r.term) seen.add(r.term.toLowerCase())
    }
    return [...seen]
  }
}

function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)) }
function round(n: number): number { return Math.round(n * 10) / 10 }
function round2(n: number): number { return Math.round(n * 100) / 100 }
