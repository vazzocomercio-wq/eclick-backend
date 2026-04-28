import { Injectable } from '@nestjs/common'

/** 3 presets pré-definidos. Aplicar um preset substitui os valores
 * correspondentes em pricing_intelligence_config (não toca em campos
 * de configuração que o preset não define — ex: custom_rules). */

export type PresetName = 'conservador' | 'equilibrado' | 'agressivo'

export interface PresetPayload {
  mode:             'disabled' | 'suggestion_only' | 'auto_with_limits' | 'full_auto'
  abc_strategies:   Record<'A'|'B'|'C', {
    min_margin_pct:         number
    max_discount_pct:       number
    approval_threshold_pct: number
    require_approval:       boolean
    priority:               'maintain_position' | 'balanced' | 'aggressive_turnover'
  }>
  triggers: {
    decrease_price: Array<{ id: string; active: boolean; params: Record<string, unknown>; label: string }>
    increase_price: Array<{ id: string; active: boolean; params: Record<string, unknown>; label: string }>
    do_not_touch:   Array<{ id: string; active: boolean; params: Record<string, unknown>; label: string }>
  }
  confidence_rules: {
    min_for_auto_action: number
    min_for_suggestion:  number
    penalties: Record<string, number>
  }
}

@Injectable()
export class PricingPresetsService {
  /** Retorna o payload completo do preset por nome. */
  get(name: PresetName): PresetPayload {
    if (name === 'conservador') return CONSERVADOR
    if (name === 'agressivo')   return AGRESSIVO
    return EQUILIBRADO
  }

  /** Lista presets disponíveis pra UI. */
  list(): PresetName[] { return ['conservador', 'equilibrado', 'agressivo'] }
}

// ── Conservador ──────────────────────────────────────────────────────────────
// Margens 25/35/45 (ABC) — proteção total. Aprovação humana sempre. Triggers
// só os mais óbvios. Confiança mínima 85% pra automático. Mode suggestion_only.
const CONSERVADOR: PresetPayload = {
  mode: 'suggestion_only',
  abc_strategies: {
    A: { min_margin_pct: 45, max_discount_pct:  5, approval_threshold_pct: 1, require_approval: true, priority: 'maintain_position' },
    B: { min_margin_pct: 35, max_discount_pct: 10, approval_threshold_pct: 3, require_approval: true, priority: 'balanced' },
    C: { min_margin_pct: 25, max_discount_pct: 15, approval_threshold_pct: 5, require_approval: true, priority: 'balanced' },
  },
  triggers: {
    decrease_price: [
      { id: 'ctr_drop',          active: true,  params: { drop_pct: 30, days: 14 }, label: 'CTR caiu mais que X% em Y dias E concorrente mais barato' },
      { id: 'stale_stock',       active: true,  params: { days_no_sale: 60 },        label: 'Estoque parado por X dias sem venda' },
      { id: 'curve_c_overstock', active: false, params: { coverage_days: 90 },       label: 'Curva C com cobertura > X dias' },
      { id: 'low_position',      active: false, params: { position: 5, days: 3 },    label: 'Posição no canal > X por Y dias' },
    ],
    increase_price: [
      { id: 'low_coverage',   active: true,  params: { days: 7 },             label: 'Cobertura < X dias sem compra em andamento' },
      { id: 'competitor_oos', active: true,  params: {},                      label: 'Concorrente principal esgotado' },
      { id: 'growing_demand', active: false, params: { growth_pct: 25 },      label: 'Demanda crescendo > X% semana a semana' },
      { id: 'high_roas',      active: false, params: { roas: 8, days: 7 },    label: 'ROAS > X por Y dias consecutivos' },
    ],
    do_not_touch: [
      { id: 'incoming_purchase', active: true, params: { days: 21 },     label: 'Compra chegando em < X dias' },
      { id: 'recent_change',     active: true, params: { days: 7 },      label: 'Mudança nos últimos X dias' },
      { id: 'active_ads',        active: true, params: { min_roas: 2 },  label: 'Em campanha Ads com ROAS > X' },
      { id: 'low_stock_safe',    active: true, params: { units: 10 },    label: 'Estoque < X unidades (modo conservador)' },
    ],
  },
  confidence_rules: {
    min_for_auto_action: 85,
    min_for_suggestion:  60,
    penalties: { no_cost_data: 40, no_sales_history: 25, no_competitor_data: 30, new_product_under_30d: 20, stale_data_over_48h: 15 },
  },
}

// ── Equilibrado (default) ────────────────────────────────────────────────────
const EQUILIBRADO: PresetPayload = {
  mode: 'auto_with_limits',
  abc_strategies: {
    A: { min_margin_pct: 35, max_discount_pct:  8, approval_threshold_pct:  3, require_approval: true,  priority: 'maintain_position' },
    B: { min_margin_pct: 25, max_discount_pct: 15, approval_threshold_pct:  5, require_approval: false, priority: 'balanced' },
    C: { min_margin_pct: 15, max_discount_pct: 25, approval_threshold_pct: 10, require_approval: false, priority: 'aggressive_turnover' },
  },
  triggers: {
    decrease_price: [
      { id: 'ctr_drop',          active: true,  params: { drop_pct: 20, days: 7 },  label: 'CTR caiu mais que X% em Y dias E concorrente mais barato' },
      { id: 'stale_stock',       active: true,  params: { days_no_sale: 45 },        label: 'Estoque parado por X dias sem venda' },
      { id: 'curve_c_overstock', active: true,  params: { coverage_days: 90 },       label: 'Curva C com cobertura > X dias' },
      { id: 'low_position',      active: false, params: { position: 5, days: 3 },    label: 'Posição no canal > X por Y dias' },
    ],
    increase_price: [
      { id: 'low_coverage',   active: true, params: { days: 10 },           label: 'Cobertura < X dias sem compra em andamento' },
      { id: 'competitor_oos', active: true, params: {},                     label: 'Concorrente principal esgotado' },
      { id: 'growing_demand', active: true, params: { growth_pct: 15 },     label: 'Demanda crescendo > X% semana a semana' },
      { id: 'high_roas',      active: true, params: { roas: 5, days: 3 },   label: 'ROAS > X por Y dias consecutivos' },
    ],
    do_not_touch: [
      { id: 'incoming_purchase', active: true, params: { days: 15 },     label: 'Compra chegando em < X dias' },
      { id: 'recent_change',     active: true, params: { days: 3 },      label: 'Mudança nos últimos X dias' },
      { id: 'active_ads',        active: true, params: { min_roas: 3 },  label: 'Em campanha Ads com ROAS > X' },
      { id: 'low_stock_safe',    active: true, params: { units: 5 },     label: 'Estoque < X unidades (modo conservador)' },
    ],
  },
  confidence_rules: {
    min_for_auto_action: 75,
    min_for_suggestion:  50,
    penalties: { no_cost_data: 30, no_sales_history: 20, no_competitor_data: 25, new_product_under_30d: 15, stale_data_over_48h: 10 },
  },
}

// ── Agressivo ────────────────────────────────────────────────────────────────
// Margens 10/15/25 (ABC). Aprovação só Curva A acima de 5%. Todos triggers
// ativos incluindo position. Confiança mínima 65%. Mode auto_with_limits.
const AGRESSIVO: PresetPayload = {
  mode: 'auto_with_limits',
  abc_strategies: {
    A: { min_margin_pct: 25, max_discount_pct: 12, approval_threshold_pct:  5, require_approval: true,  priority: 'maintain_position' },
    B: { min_margin_pct: 15, max_discount_pct: 20, approval_threshold_pct:  8, require_approval: false, priority: 'aggressive_turnover' },
    C: { min_margin_pct: 10, max_discount_pct: 35, approval_threshold_pct: 15, require_approval: false, priority: 'aggressive_turnover' },
  },
  triggers: {
    decrease_price: [
      { id: 'ctr_drop',          active: true, params: { drop_pct: 15, days: 5 },  label: 'CTR caiu mais que X% em Y dias E concorrente mais barato' },
      { id: 'stale_stock',       active: true, params: { days_no_sale: 30 },        label: 'Estoque parado por X dias sem venda' },
      { id: 'curve_c_overstock', active: true, params: { coverage_days: 60 },       label: 'Curva C com cobertura > X dias' },
      { id: 'low_position',      active: true, params: { position: 4, days: 2 },    label: 'Posição no canal > X por Y dias' },
    ],
    increase_price: [
      { id: 'low_coverage',   active: true, params: { days: 14 },           label: 'Cobertura < X dias sem compra em andamento' },
      { id: 'competitor_oos', active: true, params: {},                     label: 'Concorrente principal esgotado' },
      { id: 'growing_demand', active: true, params: { growth_pct: 10 },     label: 'Demanda crescendo > X% semana a semana' },
      { id: 'high_roas',      active: true, params: { roas: 4, days: 2 },   label: 'ROAS > X por Y dias consecutivos' },
    ],
    do_not_touch: [
      { id: 'incoming_purchase', active: true, params: { days: 10 },     label: 'Compra chegando em < X dias' },
      { id: 'recent_change',     active: true, params: { days: 1 },      label: 'Mudança nos últimos X dias' },
      { id: 'active_ads',        active: true, params: { min_roas: 4 },  label: 'Em campanha Ads com ROAS > X' },
      { id: 'low_stock_safe',    active: true, params: { units: 3 },     label: 'Estoque < X unidades (modo conservador)' },
    ],
  },
  confidence_rules: {
    min_for_auto_action: 65,
    min_for_suggestion:  45,
    penalties: { no_cost_data: 25, no_sales_history: 15, no_competitor_data: 20, new_product_under_30d: 10, stale_data_over_48h: 8 },
  },
}
