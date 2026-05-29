/** F18 F4.1 — Match Score (A Ponte / Matchmaker).
 *
 *  O diferencial de mercado: conecta vendedor da base e-Click com afiliados
 *  por FIT real, não só por quem aceita comissão. Score combina:
 *    nicho × alcance × canal × histórico de conversão
 *
 *  Vendedor propõe comissão → afiliado de bom fit aceita → ciclo medido
 *  em shopee.conversions (F2.5). Métrica north-star: GMV gerado via
 *  afiliados DA PLATAFORMA (F4.5).
 */

/** Perfil do afiliado no diretório (opt-in via Consent gate F4.3). */
export interface AffiliateProfileInput {
  /** Nichos que o afiliado cobre (ex: ['iluminacao','decoracao']). */
  niches:            string[]
  /** Canais ativos (whatsapp/instagram/tiktok/shopee_video/shopee_live/blog). */
  channels:          string[]
  /** Alcance estimado (seguidores/audiência somada). */
  reach_estimate:    number
  /** Taxa média de conversão histórica do afiliado (0-1). */
  avg_conversion_rate?: number | null
  /** Conversão por nicho específico (0-1) — refina o history. */
  niche_conversion?: Record<string, number> | null
}

/** Produto/oferta do vendedor sendo matcheado. */
export interface MatchProductInput {
  category?:  string | null
  /** Nicho normalizado do produto (deriva da categoria se ausente). */
  niche?:     string | null
  /** Canais onde a categoria converte bem (default: todos). */
  good_channels?: string[]
}

export interface MatchBreakdown {
  score:    number
  components: {
    niche_fit:    number
    reach:        number
    channel_fit:  number
    history:      number
  }
  /** Razões legíveis pro vendedor entender o match (PT-BR). */
  reasons:  string[]
}

/** Pesos do Match Score. */
export const MATCH_WEIGHTS = {
  niche_fit:   0.35,
  reach:       0.20,
  channel_fit: 0.20,
  history:     0.25,
} as const

export type MatchStatus = 'open' | 'accepted' | 'declined' | 'active' | 'paused'
