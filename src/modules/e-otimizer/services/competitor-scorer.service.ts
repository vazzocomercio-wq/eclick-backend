/**
 * CompetitorScorerService — aplica os filtros de exclusão e o scoring
 * composto definido na spec do e-Otimizer.
 *
 * Pesos (revisados pós-feedback ChatGPT — relevância sobe pra 20%):
 *   relevance         20%
 *   organic_position  20%
 *   sales_velocity    20%
 *   health_quality    15%
 *   seller_reputation 10%
 *   catalog_full_free 10%
 *   recency           5%
 */

import { Injectable, Logger } from '@nestjs/common'
import {
  type MlSearchHit, type MlItemDetails, type MlSellerReputation,
  type ScoredCompetitor, SCORING_WEIGHTS,
} from '../e-otimizer.types'

export interface ScorerInput {
  hits:           MlSearchHit[]
  itemsDetails:   Map<string, MlItemDetails>
  sellersRep:     Map<number, MlSellerReputation>
  userKeywords:   string[]           // tokens extraídos do produto do user (pra relevância)
  excludeSellerNicknames?: string[]  // pra excluir a própria marca (ex: 'VAZZO_')
}

export interface ScorerOutput {
  scored:           ScoredCompetitor[]   // top ordenado por score
  candidates_total: number
  filtered_out:     number
  filter_reasons:   Record<string, number>  // contagem de cada razão
}

@Injectable()
export class CompetitorScorerService {
  private readonly logger = new Logger(CompetitorScorerService.name)

  scoreCompetitors(input: ScorerInput): ScorerOutput {
    const { hits, itemsDetails, sellersRep, userKeywords, excludeSellerNicknames = [] } = input
    const totalIn = hits.length
    const filterReasons: Record<string, number> = {}

    // ── 1. FILTROS DE EXCLUSÃO ─────────────────────────────────────────────
    const filtered = hits.filter(hit => {
      // Exclui própria marca
      if (excludeSellerNicknames.some(nick => hit.seller.nickname?.toUpperCase().startsWith(nick.toUpperCase()))) {
        filterReasons['own_brand'] = (filterReasons['own_brand'] ?? 0) + 1
        return false
      }

      // Vendedor com reputação ruim
      const rep = sellersRep.get(hit.seller.id)
      const repLevel = rep?.level_id
      if (repLevel && !['5_green', '4_light_green'].includes(repLevel)) {
        filterReasons['bad_reputation'] = (filterReasons['bad_reputation'] ?? 0) + 1
        return false
      }

      // Recém-criado sem vendas
      const details = itemsDetails.get(hit.id)
      if (details) {
        const daysOnAir = this.daysSince(details.date_created)
        if (daysOnAir < 30 && hit.sold_quantity === 0) {
          filterReasons['new_no_sales'] = (filterReasons['new_no_sales'] ?? 0) + 1
          return false
        }
      }

      // Tag suspeita
      if (hit.tags?.includes('dragged_bids_and_visits')) {
        filterReasons['suspicious_activity'] = (filterReasons['suspicious_activity'] ?? 0) + 1
        return false
      }

      // Quantidade absurda sem catálogo (provável dropshipper)
      if (hit.available_quantity > 1000 && !hit.catalog_listing) {
        filterReasons['mass_dropshipper'] = (filterReasons['mass_dropshipper'] ?? 0) + 1
        return false
      }

      return true
    })

    // Outlier de preço (após filtros básicos pra usar mediana representativa)
    const prices = filtered.map(h => h.price).filter(p => p > 0).sort((a, b) => a - b)
    if (prices.length >= 5) {
      const median = prices[Math.floor(prices.length / 2)]
      const survived = filtered.filter(h => {
        const ratio = h.price / median
        if (ratio > 3 || ratio < 0.33) {
          filterReasons['price_outlier'] = (filterReasons['price_outlier'] ?? 0) + 1
          return false
        }
        return true
      })
      filtered.length = 0
      filtered.push(...survived)
    }

    // ── 2. SCORING DE CADA SOBREVIVENTE ────────────────────────────────────
    // Pré-cálculos pra normalizar dentro do batch
    const velocities = filtered.map(h => this.computeVelocity(h, itemsDetails))
    const maxVelocity = Math.max(0.001, ...velocities)

    const scored: ScoredCompetitor[] = filtered.map((hit, idx) => {
      const details = itemsDetails.get(hit.id)
      const rep = sellersRep.get(hit.seller.id) ?? null
      const daysOnAir = details ? this.daysSince(details.date_created) : null
      const velocity = velocities[idx]

      const s = {
        relevance:          this.scoreRelevance(hit.title, userKeywords),
        organic_position:   this.scoreOrganicPosition(hit.position_in_results),
        sales_velocity:     velocity / maxVelocity,
        health_quality:    hit.health ?? 0.5,  // null = neutro
        seller_reputation:  this.scoreSellerReputation(hit, rep),
        catalog_full_free:  this.scoreCatalogFullFree(hit),
        recency:            this.scoreRecency(daysOnAir),
        final:              0,  // calculado abaixo
      }
      s.final =
          SCORING_WEIGHTS.relevance         * s.relevance
        + SCORING_WEIGHTS.organic_position  * s.organic_position
        + SCORING_WEIGHTS.sales_velocity    * s.sales_velocity
        + SCORING_WEIGHTS.health_quality   * s.health_quality
        + SCORING_WEIGHTS.seller_reputation * s.seller_reputation
        + SCORING_WEIGHTS.catalog_full_free * s.catalog_full_free
        + SCORING_WEIGHTS.recency           * s.recency

      return {
        mlb_id:              hit.id,
        title:               hit.title,
        permalink:           hit.permalink,
        thumbnail:           hit.thumbnail,
        price:               hit.price,
        sold_quantity:       hit.sold_quantity,
        days_on_air:         daysOnAir,
        seller_nickname:     hit.seller.nickname,
        power_seller_status: hit.seller.power_seller_status,
        reputation_level:    rep?.level_id ?? null,
        position_in_results: hit.position_in_results,
        catalog_listing:     hit.catalog_listing,
        free_shipping:       hit.shipping.free_shipping,
        is_fulfillment:      hit.shipping.logistic_type === 'fulfillment',
        scores:              s,
      }
    })

    scored.sort((a, b) => b.scores.final - a.scores.final)

    this.logger.log(
      `[scorer] ${totalIn} hits → ${filtered.length} sobreviveram, ` +
      `top score=${scored[0]?.scores.final.toFixed(3) ?? 'n/a'}, reasons=${JSON.stringify(filterReasons)}`,
    )

    return {
      scored,
      candidates_total: totalIn,
      filtered_out:     totalIn - filtered.length,
      filter_reasons:   filterReasons,
    }
  }

  // ── Score components ────────────────────────────────────────────────────

  /** Jaccard simples entre keywords do título do competidor e do produto do user. */
  private scoreRelevance(title: string, userKeywords: string[]): number {
    if (userKeywords.length === 0) return 0.5  // sem keywords pra comparar
    const titleTokens = new Set(this.tokenize(title))
    const userTokens = new Set(userKeywords.map(k => k.toLowerCase()))
    let intersection = 0
    for (const t of userTokens) {
      if (titleTokens.has(t)) intersection++
    }
    const union = new Set([...titleTokens, ...userTokens]).size
    return union > 0 ? intersection / union : 0
  }

  /** Posição 1 (idx 0) = 1.0, posição 50 (idx 49) = 0.02 — linear decay. */
  private scoreOrganicPosition(position0: number): number {
    return Math.max(0, (50 - position0) / 50)
  }

  /** sold_quantity / days_on_air (proxy de vendas por dia). */
  private computeVelocity(hit: MlSearchHit, itemsDetails: Map<string, MlItemDetails>): number {
    const details = itemsDetails.get(hit.id)
    if (!details) return hit.sold_quantity / 365  // fallback conservador
    const days = Math.max(1, this.daysSince(details.date_created))
    return hit.sold_quantity / days
  }

  /** Score 0-1 baseado em power_seller + cor + taxa de claims. */
  private scoreSellerReputation(hit: MlSearchHit, rep: MlSellerReputation | null): number {
    let psBonus = 0
    switch (hit.seller.power_seller_status) {
      case 'platinum': psBonus = 1.0; break
      case 'gold':     psBonus = 0.8; break
      case 'silver':   psBonus = 0.5; break
      default:         psBonus = 0.2
    }
    let repBonus = 0.5  // neutro se desconhecido
    if (rep?.level_id) {
      switch (rep.level_id) {
        case '5_green':       repBonus = 1.0; break
        case '4_light_green': repBonus = 0.8; break
        case '3_yellow':      repBonus = 0.5; break
        case '2_orange':      repBonus = 0.2; break
        case '1_red':         repBonus = 0.0; break
      }
    }
    const claimsBonus = rep?.metrics.claims_rate != null
      ? Math.max(0, 1 - rep.metrics.claims_rate)
      : 0.7
    return (psBonus + repBonus + claimsBonus) / 3
  }

  /** Bonus combinado: catálogo + fulfillment + frete grátis (cada um vale 1/3). */
  private scoreCatalogFullFree(hit: MlSearchHit): number {
    const catalog = hit.catalog_listing ? 1 : 0
    const full = hit.shipping.logistic_type === 'fulfillment' ? 1 : 0
    const freeShipping = hit.shipping.free_shipping ? 1 : 0
    return (catalog + full + freeShipping) / 3
  }

  /** Curva U-invertida: sweet spot 30-90 dias. */
  private scoreRecency(daysOnAir: number | null): number {
    if (daysOnAir == null) return 0.5
    if (daysOnAir < 30)  return 0.3
    if (daysOnAir < 90)  return 1.0
    if (daysOnAir < 365) return 0.8
    return 0.5
  }

  // ── Utils ───────────────────────────────────────────────────────────────

  private daysSince(isoDate: string | undefined): number {
    if (!isoDate) return 0
    const ms = Date.now() - new Date(isoDate).getTime()
    return Math.floor(ms / (1000 * 60 * 60 * 24))
  }

  /** Tokeniza título em palavras significativas (sem stopwords óbvias). */
  private tokenize(text: string): string[] {
    const STOPWORDS = new Set([
      'de','da','do','para','com','em','e','a','o','as','os','um','uma',
      'no','na','nos','nas','por','pra','que','tem','é','sem','su','for',
    ])
    return text
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')   // tira acentos
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2 && !STOPWORDS.has(t))
  }
}
