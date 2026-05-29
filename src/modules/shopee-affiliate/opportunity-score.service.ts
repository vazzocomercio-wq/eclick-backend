import { Injectable } from '@nestjs/common'
import {
  AffiliateOfferInput, OpportunityBreakdown,
  OPPORTUNITY_WEIGHTS, OPPORTUNITY_GATES,
} from './opportunity-score.types'

/** F18 F2.3 — Motor do Opportunity Score. Pure (sem I/O) → testável.
 *
 *  compute() devolve score 0-100 + breakdown + flag de exclusão. O ranking
 *  do Discovery Engine ordena por score desc, com excluded no fim. */
@Injectable()
export class OpportunityScoreService {
  /** Computa Opportunity Score de uma oferta. */
  compute(o: AffiliateOfferInput): OpportunityBreakdown {
    // ── Filtro de saída PRIMEIRO ────────────────────────────────────────────
    // rating < 4.5 OU seller fraco = não vale promover (devolução cancela
    // comissão). Não zeramos os componentes — calculamos pra transparência,
    // mas o score final vira 0 + excluded=true.
    let excluded = false
    let excludeReason: string | null = null

    if (o.rating != null && o.rating < OPPORTUNITY_GATES.min_rating) {
      excluded = true
      excludeReason = `Nota ${o.rating.toFixed(1)} < ${OPPORTUNITY_GATES.min_rating} — risco alto de devolução (cancela comissão).`
    } else if (o.seller_score != null && o.seller_score < OPPORTUNITY_GATES.min_seller_score) {
      excluded = true
      excludeReason = `Reputação do vendedor ${o.seller_score}/100 baixa — risco de cancelamento.`
    }

    // ── Componentes (0-100) ─────────────────────────────────────────────────

    // Commission: Shopee BR 3-15% normal, bônus até 80%. Linear até 15%=80,
    // 30%+=100. Comissão sozinha não basta (peso 30%).
    const rate = clampNum(o.commission_rate, 0, 1)
    let commission: number
    if (rate >= 0.30)      commission = 100
    else if (rate >= 0.15) commission = Math.round(80 + ((rate - 0.15) / 0.15) * 20)
    else                   commission = Math.round((rate / 0.15) * 80)

    // Conversion estimate: combina rating (satisfação) + sales_volume (prova
    // social). Sem dados → neutro 50.
    const conversion = this.conversionScore(o)

    // Seller: direto (0-100). Sem dado → 50 neutro.
    const seller = o.seller_score != null ? clampNum(o.seller_score, 0, 100) : 50

    // Trend: direto do Radar (0-100). Sem dado → 50 neutro.
    const trend = o.trend_score != null ? clampNum(o.trend_score, 0, 100) : 50

    const rawScore = Math.round(
      OPPORTUNITY_WEIGHTS.commission * commission +
      OPPORTUNITY_WEIGHTS.conversion * conversion +
      OPPORTUNITY_WEIGHTS.seller     * seller +
      OPPORTUNITY_WEIGHTS.trend      * trend,
    )

    return {
      score:          excluded ? 0 : clampNum(rawScore, 0, 100),
      components:     { commission, conversion, seller, trend },
      excluded,
      exclude_reason: excludeReason,
      conv_estimate:  this.convEstimate(o),
    }
  }

  /** Score de conversão (0-100): rating 60% + volume 40%. */
  private conversionScore(o: AffiliateOfferInput): number {
    const ratingPart = o.rating != null
      ? Math.round((clampNum(o.rating, 0, 5) / 5) * 100)
      : 50
    let volumePart: number
    const v = o.sales_volume ?? null
    if (v == null)      volumePart = 50
    else if (v >= 1000) volumePart = 100
    else if (v >= 100)  volumePart = Math.round(60 + ((v - 100) / 900) * 40)
    else if (v >= 10)   volumePart = Math.round(30 + ((v - 10) / 90) * 30)
    else                volumePart = Math.round((v / 10) * 30)
    return Math.round(ratingPart * 0.6 + volumePart * 0.4)
  }

  /** Estimativa de conversão (0-1) derivada — pra projeção de receita.
   *  Heurística: produto bem avaliado + alto volume converte ~5-8%. */
  private convEstimate(o: AffiliateOfferInput): number {
    const base = 0.02
    const ratingBoost = o.rating != null ? (clampNum(o.rating, 0, 5) / 5) * 0.04 : 0.01
    const volBoost = (o.sales_volume ?? 0) >= 500 ? 0.02 : 0
    return Math.round((base + ratingBoost + volBoost) * 1000) / 1000
  }
}

function clampNum(v: number | null | undefined, min: number, max: number): number {
  if (v == null || !Number.isFinite(v)) return min
  return Math.max(min, Math.min(max, v))
}
