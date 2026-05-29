import { Injectable } from '@nestjs/common'
import {
  AffiliateProfileInput, MatchProductInput, MatchBreakdown, MATCH_WEIGHTS,
} from './match-score.types'

/** F18 F4.1 — Motor do Match Score. Pure (sem I/O) → testável. */
@Injectable()
export class MatchScoreService {
  /** Computa fit produto↔afiliado (0-100) + breakdown + razões. */
  compute(product: MatchProductInput, affiliate: AffiliateProfileInput): MatchBreakdown {
    const reasons: string[] = []
    const productNiche = (product.niche ?? product.category ?? '').toLowerCase().trim()

    // ── Niche fit (35%) ─────────────────────────────────────────────────────
    // Afiliado cobre o nicho do produto? Match exato = 100; nicho relacionado
    // (substring) = 60; sem overlap = 0.
    const affNiches = affiliate.niches.map(n => n.toLowerCase().trim())
    let nicheFit: number
    if (!productNiche) {
      nicheFit = 50
    } else if (affNiches.includes(productNiche)) {
      nicheFit = 100
      reasons.push(`Afiliado cobre exatamente o nicho "${productNiche}".`)
    } else if (affNiches.some(n => n.includes(productNiche) || productNiche.includes(n))) {
      nicheFit = 60
      reasons.push(`Afiliado atua em nicho relacionado a "${productNiche}".`)
    } else {
      nicheFit = 10
      reasons.push(`Nicho do afiliado não bate com "${productNiche}" — match fraco.`)
    }

    // ── Reach (20%) ─────────────────────────────────────────────────────────
    // Normaliza alcance: 100k+ = 100, 10k = 60, 1k = 30, <100 = 5.
    const reach = affiliate.reach_estimate ?? 0
    let reachScore: number
    if (reach >= 100_000)     { reachScore = 100; reasons.push('Alcance alto (100k+).') }
    else if (reach >= 10_000) { reachScore = 60 + Math.round(((reach - 10_000) / 90_000) * 40) }
    else if (reach >= 1_000)  { reachScore = 30 + Math.round(((reach - 1_000) / 9_000) * 30) }
    else if (reach >= 100)    { reachScore = 10 + Math.round(((reach - 100) / 900) * 20) }
    else                      { reachScore = 5 }

    // ── Channel fit (20%) ───────────────────────────────────────────────────
    // Interseção entre canais do afiliado e canais bons pra categoria.
    const goodChannels = (product.good_channels && product.good_channels.length > 0)
      ? product.good_channels.map(c => c.toLowerCase())
      : ['whatsapp', 'instagram', 'tiktok', 'shopee_video', 'shopee_live', 'blog']
    const affChannels = affiliate.channels.map(c => c.toLowerCase())
    const overlap = affChannels.filter(c => goodChannels.includes(c))
    const channelFit = affChannels.length > 0
      ? Math.round((overlap.length / Math.min(affChannels.length, goodChannels.length)) * 100)
      : 0
    if (overlap.length > 0) {
      reasons.push(`Canais compatíveis: ${overlap.join(', ')}.`)
    } else {
      reasons.push('Sem canais compatíveis com a categoria.')
    }

    // ── History (25%) ─────────────────────────────────────────────────────────
    // Conversão histórica no nicho específico > média geral > neutro.
    const nicheConv = productNiche && affiliate.niche_conversion?.[productNiche]
    const conv = (nicheConv ?? affiliate.avg_conversion_rate ?? null)
    let historyScore: number
    if (conv == null) {
      historyScore = 50
    } else if (conv >= 0.08) { historyScore = 100; reasons.push(`Conversão histórica forte (${(conv * 100).toFixed(1)}%).`) }
    else if (conv >= 0.04)   { historyScore = 70 }
    else if (conv >= 0.02)   { historyScore = 45 }
    else                     { historyScore = 20; reasons.push(`Conversão histórica baixa (${(conv * 100).toFixed(1)}%).`) }

    const score = Math.round(
      MATCH_WEIGHTS.niche_fit   * nicheFit +
      MATCH_WEIGHTS.reach       * reachScore +
      MATCH_WEIGHTS.channel_fit * channelFit +
      MATCH_WEIGHTS.history     * historyScore,
    )

    return {
      score: Math.max(0, Math.min(100, score)),
      components: {
        niche_fit:   nicheFit,
        reach:       reachScore,
        channel_fit: channelFit,
        history:     historyScore,
      },
      reasons,
    }
  }
}
