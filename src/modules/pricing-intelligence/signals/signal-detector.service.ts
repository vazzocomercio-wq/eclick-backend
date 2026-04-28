import { Injectable, Logger } from '@nestjs/common'
import { ProductSnapshot, PricingSignal, Severity } from './types'

/** Avalia gatilhos contra snapshot. Ordem importa:
 * 1. DO_NOT_TOUCH primeiro — se algum ativo, gera signal "do_not_touch"
 *    e ABORTA (não avalia decrease/increase). Protege contra ações
 *    impulsivas.
 * 2. DECREASE triggers
 * 3. INCREASE triggers
 *
 * Cada signal passa por SAFETY check: suggested_price >= cost / (1 - margin),
 * suggested != current, confidence >= min_for_suggestion. Se falha
 * confidence, downgrade pra 'low_confidence' em vez de descartar. */
@Injectable()
export class SignalDetectorService {
  private readonly logger = new Logger(SignalDetectorService.name)

  detectSignals(orgId: string, snap: ProductSnapshot): PricingSignal[] {
    const signals: PricingSignal[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = snap.config_for_org as any
    const triggers = config?.triggers ?? {}
    const abcStrategies = config?.abc_strategies ?? {}
    const confidenceCfg = config?.confidence_rules ?? {}

    // ── 1. DO_NOT_TOUCH first ────────────────────────────────────────────
    const dntActive = (triggers.do_not_touch ?? []).filter((t: { active: boolean }) => t.active)
    for (const trig of dntActive) {
      const reason = this.evalDoNotTouch(trig, snap)
      if (reason) {
        signals.push(this.buildSignal({
          orgId, snap,
          signal_type: 'do_not_touch',
          trigger_id:  trig.id,
          severity:    'medium',
          title:       `Não mexer: ${reason.label}`,
          description: reason.description,
          suggested_price: snap.product.current_price,
        }))
        // Bloqueia outros tipos
        return signals
      }
    }

    // ── 2. DECREASE triggers ─────────────────────────────────────────────
    const decActive = (triggers.decrease_price ?? []).filter((t: { active: boolean }) => t.active)
    for (const trig of decActive) {
      const result = this.evalDecrease(trig, snap)
      if (!result) continue
      const sig = this.buildPriceSignal({
        orgId, snap,
        direction: 'decrease',
        trigger:   trig,
        evidence:  result,
        abcStrategies,
        confidenceCfg,
      })
      if (sig) signals.push(sig)
    }

    // ── 3. INCREASE triggers ─────────────────────────────────────────────
    const incActive = (triggers.increase_price ?? []).filter((t: { active: boolean }) => t.active)
    for (const trig of incActive) {
      const result = this.evalIncrease(trig, snap)
      if (!result) continue
      const sig = this.buildPriceSignal({
        orgId, snap,
        direction: 'increase',
        trigger:   trig,
        evidence:  result,
        abcStrategies,
        confidenceCfg,
      })
      if (sig) signals.push(sig)
    }

    // Ordena por severity desc (critical > high > medium > low)
    const sevOrder: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 }
    signals.sort((a, b) => sevOrder[b.severity] - sevOrder[a.severity])

    return signals
  }

  // ── Trigger evaluators ──────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private evalDoNotTouch(trig: any, snap: ProductSnapshot): { label: string; description: string } | null {
    const params = trig.params ?? {}
    if (trig.id === 'incoming_purchase' && snap.incoming.has_incoming && snap.incoming.arrival_days != null) {
      if (snap.incoming.arrival_days < (params.days ?? 15)) {
        return { label: 'compra chegando', description: `${snap.incoming.units} unidades chegam em ${snap.incoming.arrival_days} dias.` }
      }
    }
    if (trig.id === 'recent_change' && snap.history.days_since_last_change != null) {
      if (snap.history.days_since_last_change < (params.days ?? 3)) {
        return { label: 'mudança recente', description: `Preço mudou há ${snap.history.days_since_last_change} dias.` }
      }
    }
    if (trig.id === 'active_ads' && snap.ads.in_active_campaign) {
      const minRoas = params.min_roas ?? 3
      if ((snap.ads.roas_7d ?? Infinity) >= minRoas) {
        return { label: 'em campanha Ads', description: `ROAS ≥ ${minRoas} na última semana — não mexer durante campanha.` }
      }
    }
    if (trig.id === 'low_stock_safe' && snap.stock.quantity != null) {
      if (snap.stock.quantity < (params.units ?? 5)) {
        return { label: 'estoque baixo', description: `Apenas ${snap.stock.quantity} unidades — modo conservador.` }
      }
    }
    return null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private evalDecrease(trig: any, snap: ProductSnapshot): { label: string; severity: Severity; evidence: Record<string, unknown> } | null {
    const params = trig.params ?? {}
    if (trig.id === 'ctr_drop') {
      // Sem CTR histórico no v1 → skip silenciosamente
      if (snap.ads.ctr_7d == null) return null
      // V1 só dispara se também há concorrente mais barato
      if (snap.competitors.min_price && snap.product.current_price && snap.competitors.min_price < snap.product.current_price) {
        return { label: 'CTR em queda + concorrente mais barato', severity: 'high', evidence: { ctr_7d: snap.ads.ctr_7d, min_competitor: snap.competitors.min_price } }
      }
      return null
    }
    if (trig.id === 'stale_stock') {
      if (snap.sales.days_since_last_sale != null && snap.sales.days_since_last_sale > (params.days_no_sale ?? 45)) {
        return { label: `${snap.sales.days_since_last_sale} dias sem venda`, severity: snap.sales.days_since_last_sale > 90 ? 'high' : 'medium', evidence: { days_since_last_sale: snap.sales.days_since_last_sale } }
      }
      return null
    }
    if (trig.id === 'curve_c_overstock') {
      if (snap.abc_curve === 'C' && snap.stock.coverage_days != null && snap.stock.coverage_days > (params.coverage_days ?? 90)) {
        return { label: `Curva C com ${snap.stock.coverage_days}d de cobertura`, severity: 'medium', evidence: { coverage_days: snap.stock.coverage_days } }
      }
      return null
    }
    if (trig.id === 'low_position') {
      if (snap.competitors.position_in_channel != null && snap.competitors.position_in_channel > (params.position ?? 5)) {
        return { label: `Posição ${snap.competitors.position_in_channel} no canal`, severity: 'medium', evidence: { position: snap.competitors.position_in_channel } }
      }
      return null
    }
    return null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private evalIncrease(trig: any, snap: ProductSnapshot): { label: string; severity: Severity; evidence: Record<string, unknown> } | null {
    const params = trig.params ?? {}
    if (trig.id === 'low_coverage') {
      if (snap.stock.coverage_days != null && snap.stock.coverage_days < (params.days ?? 10) && !snap.incoming.has_incoming) {
        return { label: `Cobertura ${snap.stock.coverage_days}d sem reposição em andamento`, severity: snap.stock.coverage_days < 5 ? 'critical' : 'high', evidence: { coverage_days: snap.stock.coverage_days } }
      }
      return null
    }
    if (trig.id === 'competitor_oos' && snap.competitors.main_competitor_oos) {
      return { label: 'Concorrente principal esgotado', severity: 'high', evidence: { main_competitor_oos: true } }
    }
    if (trig.id === 'growing_demand') {
      if (snap.sales.trend_7d_vs_30d_pct != null && snap.sales.trend_7d_vs_30d_pct > (params.growth_pct ?? 15)) {
        return { label: `Demanda +${snap.sales.trend_7d_vs_30d_pct.toFixed(0)}% sem reposição`, severity: 'medium', evidence: { trend_pct: snap.sales.trend_7d_vs_30d_pct } }
      }
      return null
    }
    if (trig.id === 'high_roas') {
      if (snap.ads.roas_7d != null && snap.ads.roas_7d > (params.roas ?? 5)) {
        return { label: `ROAS ${snap.ads.roas_7d.toFixed(1)} forte`, severity: 'medium', evidence: { roas_7d: snap.ads.roas_7d } }
      }
      return null
    }
    return null
  }

  // ── Builders ────────────────────────────────────────────────────────────

  private buildPriceSignal(input: {
    orgId:           string
    snap:            ProductSnapshot
    direction:       'decrease' | 'increase'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trigger:         any
    evidence:        { label: string; severity: Severity; evidence: Record<string, unknown> }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    abcStrategies:   any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    confidenceCfg:   any
  }): PricingSignal | null {
    const { orgId, snap, direction, trigger, evidence, abcStrategies, confidenceCfg } = input
    const cur = snap.product.current_price
    if (cur == null || cur <= 0) return null

    // Determina ABC strategy
    const curve = snap.abc_curve ?? 'B'
    const strategy = abcStrategies[curve] ?? abcStrategies.B ?? { min_margin_pct: 25, max_discount_pct: 15 }
    const minMargin = Number(strategy.min_margin_pct ?? 25)
    const maxDiscount = Number(strategy.max_discount_pct ?? 15)

    // Suggested price: simples — % conservador na direção
    const moveStrength = evidence.severity === 'critical' ? 0.10 :
                         evidence.severity === 'high'     ? 0.07 :
                         evidence.severity === 'medium'   ? 0.04 : 0.02
    const factor = direction === 'decrease'
      ? Math.max(1 - moveStrength, 1 - maxDiscount / 100)
      : 1 + moveStrength
    let suggested = Math.round(cur * factor * 100) / 100

    // SAFETY: nunca abaixo de cost/(1 - minMargin)
    let minSafe: number | null = null
    if (snap.product.cost_price && snap.product.cost_price > 0) {
      minSafe = Math.round((snap.product.cost_price / Math.max(0.01, 1 - minMargin / 100)) * 100) / 100
      if (suggested < minSafe) suggested = minSafe
    }

    // Sem mudança? Pula.
    if (Math.abs(suggested - cur) < 0.01) return null

    // Margem atual
    const currentMargin = snap.product.cost_price && snap.product.cost_price > 0
      ? Math.round(((cur - snap.product.cost_price) / cur) * 10000) / 100
      : null

    // Confidence check
    const minForSuggestion = Number(confidenceCfg.min_for_suggestion ?? 50)
    const isLowConfidence = snap.confidence_score < minForSuggestion

    return this.buildSignal({
      orgId, snap,
      signal_type:        isLowConfidence ? 'low_confidence' : (direction === 'decrease' ? 'decrease_price' : 'increase_price'),
      trigger_id:         trigger.id,
      severity:           evidence.severity,
      title:              `${direction === 'decrease' ? 'Baixar' : 'Subir'} preço: ${evidence.label}`,
      description:        `Sugestão: R$ ${cur.toFixed(2)} → R$ ${suggested.toFixed(2)}${minSafe ? ` (mín seguro R$ ${minSafe.toFixed(2)})` : ''}`,
      suggested_price:    suggested,
      min_safe_price:     minSafe,
      current_margin_pct: currentMargin,
      signal_data: { ...evidence.evidence, abc_curve: curve, direction },
    })
  }

  private buildSignal(input: {
    orgId:               string
    snap:                ProductSnapshot
    signal_type:         PricingSignal['signal_type']
    trigger_id:          string
    severity:            Severity
    title:               string
    description:         string | null
    suggested_price?:    number | null
    min_safe_price?:     number | null
    current_margin_pct?: number | null
    signal_data?:        Record<string, unknown>
  }): PricingSignal {
    return {
      organization_id:     input.orgId,
      product_id:          input.snap.product.id,
      listing_id:          input.snap.product.listing_id ?? null,
      channel:             'mercadolivre',
      signal_type:         input.signal_type,
      trigger_id:          input.trigger_id,
      severity:            input.severity,
      title:               `${input.snap.product.name ?? input.snap.product.sku ?? 'Produto'} — ${input.title}`,
      description:         input.description,
      current_price:       input.snap.product.current_price,
      suggested_price:     input.suggested_price ?? null,
      current_margin_pct:  input.current_margin_pct ?? null,
      min_safe_price:      input.min_safe_price ?? null,
      signal_data:         input.signal_data ?? {},
      confidence_score:    input.snap.confidence_score,
      confidence_breakdown: input.snap.confidence_breakdown,
    }
  }
}
