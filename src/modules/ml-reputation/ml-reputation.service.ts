import { Injectable, Logger, Optional } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { EventsGateway } from '../events/events.gateway'
import { AlertSignalsService } from '../intelligence-hub/alert-signals.service'
import type { AlertSeverity, SignalDraft } from '../intelligence-hub/analyzers/analyzers.types'
import { ExecutiveReputationService } from '../executive-dashboard/executive-reputation.service'
import { computeReputation, officialFromRow, simulateReputation } from './ml-reputation.engine'
import { levelRank, toSaoPauloDate } from './ml-reputation.rules'
import { MlReputationDataService } from './ml-reputation-data.service'
import { MlReputationRulesService } from './ml-reputation-rules.service'
import {
  METRIC_KEYS, RISK_ORDER,
  type LevelOrUnknown, type MetricKey, type ReputationInput, type ReputationResult, type ReputationRuleSet,
  type RiskOrUnknown, type SimulationInput, type WindowCounts,
} from './ml-reputation.types'

/** O que fica gravado em ml_reputation_current.result. */
export interface StoredResult {
  active:   ReputationResult
  /** Mesmo cálculo com a próxima regra (ex.: 10/09/2026) — "simulação" antes da vigência. */
  upcoming: ReputationResult | null
  /** Contagens brutas das duas janelas — base do simulador (sem voltar aos pedidos). */
  counts:   { short: WindowCounts; long: WindowCounts; windowExits: string[] }
}

export interface CurrentRow {
  organization_id:      string
  seller_id:            number
  rule_set_name:        string | null
  measurement_period:   number | null
  sales_60d:            number | null
  sales_365d:           number | null
  overall_level:        string | null
  risk_level:           string | null
  result:               StoredResult
  official:             unknown
  divergence:           unknown
  calculated_at:        string
  data_as_of:           string | null
  dirty_since:          string | null
  cancel_backfilled_at: string | null
  claims_backfilled_at: string | null
  last_error:           string | null
}

export interface AccountView {
  seller_id:            number
  nickname:             string | null
  status:               'ready' | 'pending' | 'error'
  calculated_at:        string | null
  cancel_backfilled_at: string | null
  last_error:           string | null
  active:               ReputationResult | null
  upcoming:             ReputationResult | null
}

export interface DashboardView {
  generated_at: string
  rules: {
    active:   Pick<ReputationRuleSet, 'name' | 'effectiveFrom' | 'effectiveUntil' | 'config' | 'notes'>
    upcoming: Pick<ReputationRuleSet, 'name' | 'effectiveFrom' | 'effectiveUntil' | 'config' | 'notes'> | null
  }
  summary: {
    total:             number
    healthy:           number   // verde e risco safe/attention
    attention:         number   // amarelo OU verde em risco alto
    critical:          number   // laranja/vermelho OU risco crítico
    near_period_switch: number  // faltam ≤ 10 vendas pros 60d, ou pode cair pra 365d
    worsened_recently: number   // evento de piora nas últimas 72h
    pending:           number
  }
  accounts: AccountView[]
}

interface DetectedEvent {
  event_type: 'level_changed' | 'period_changed' | 'near_limit' | 'back_to_safe'
  metric:     MetricKey | null
  from_value: string | null
  to_value:   string | null
  severity:   AlertSeverity
  dedupe_key: string
  cooldown_h: number
  payload:    Record<string, unknown>
  alert?:     { category: string; score: number; summary_pt: string; suggestion_pt: string }
}

const DEBOUNCE_MS         = 20_000
const WORSENED_WINDOW_H   = 72
const NEAR_SWITCH_SALES   = 10

const METRIC_LABEL_PT: Record<MetricKey, string> = {
  cancellations:      'Cancelamentos',
  incorrectShipments: 'Envios incorretos',
  claims:             'Reclamações',
}
const LEVEL_LABEL_PT: Record<string, string> = {
  green: 'Verde', yellow: 'Amarelo', orange: 'Laranja', red: 'Vermelho', unknown: 'Sem dado',
}

const fmtPct = (v: number | null) => v == null ? '—' : `${v.toFixed(2).replace('.', ',')}%`

/**
 * Orquestra o cálculo local de reputação por conta:
 *   contagens (1 RPC) + oficial (cache) + regra vigente → motor puro →
 *   grava current + snapshot do dia → detecta eventos → alertas com
 *   dedupe/cooldown → Socket.IO `reputation:updated`.
 *
 * Recalcula por: webhook (debounce 20s), cron (dirty a cada 5 min; todas
 * as contas 1×/h depois do sync oficial) e botão "Atualizar" na UI.
 */
@Injectable()
export class MlReputationService {
  private readonly logger = new Logger(MlReputationService.name)
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly inflight = new Set<string>()

  constructor(
    private readonly data:     MlReputationDataService,
    private readonly rules:    MlReputationRulesService,
    private readonly official: ExecutiveReputationService,
    private readonly signals:  AlertSignalsService,
    @Optional() private readonly events?: EventsGateway,
  ) {}

  // ── Recalcular ────────────────────────────────────────────────────────────

  /**
   * Agenda um recálculo com debounce — vários webhooks da mesma conta em
   * sequência viram 1 cálculo. Marca dirty_since no banco pro cron pegar
   * caso o processo reinicie antes do timer.
   */
  scheduleRecalc(orgId: string, sellerId: number, reason: string): void {
    const key = `${orgId}:${sellerId}`
    const existing = this.timers.get(key)
    if (existing) clearTimeout(existing)
    void supabaseAdmin
      .from('ml_reputation_current')
      .update({ dirty_since: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .then(({ error }) => { if (error) this.logger.warn(`[dirty] ${key}: ${error.message}`) })
    const t = setTimeout(() => {
      this.timers.delete(key)
      this.recalculate(orgId, sellerId, { reason }).catch(err =>
        this.logger.warn(`[recalc:${reason}] ${key}: ${(err as Error).message}`))
    }, DEBOUNCE_MS)
    // Não segura o processo vivo só por causa do timer (testes / shutdown).
    if (typeof t.unref === 'function') t.unref()
    this.timers.set(key, t)
  }

  async recalculate(
    orgId: string,
    sellerId: number,
    opts: { reason?: string; syncOfficial?: boolean; backfill?: boolean } = {},
  ): Promise<AccountView> {
    const key = `${orgId}:${sellerId}`
    if (this.inflight.has(key)) {
      // Já tem um cálculo rodando: devolve o estado atual sem duplicar trabalho.
      return this.getAccount(orgId, sellerId)
    }
    this.inflight.add(key)
    const t0 = Date.now()
    try {
      const conn = await this.data.assertAccountInOrg(orgId, sellerId)
      const previousRow = await this.fetchCurrentRow(orgId, sellerId)

      if (opts.syncOfficial) {
        try { await this.official.syncReputation(orgId, sellerId) }
        catch (err) { this.logger.warn(`[recalc] sync oficial falhou seller=${sellerId}: ${(err as Error).message}`) }
      }

      const now  = new Date()
      const date = toSaoPauloDate(now)
      const [active, upcoming] = await Promise.all([this.rules.getActive(date), this.rules.getUpcoming(date)])
      const cfg = active.config

      // Backfills 1× por conta (ou quando pedido): cancel_detail nos pedidos
      // cancelados e histórico de reclamações. Falha não derruba o cálculo —
      // fica registrada e tenta de novo no próximo recálculo.
      let cancelBackfilledAt = previousRow?.cancel_backfilled_at ?? null
      if (opts.backfill || !cancelBackfilledAt) {
        try {
          await this.data.backfillCancelDetails(orgId, sellerId, cfg.measurement.longPeriodDays)
          cancelBackfilledAt = new Date().toISOString()
        } catch (err) {
          this.logger.warn(`[recalc] backfill cancel_detail falhou seller=${sellerId}: ${(err as Error).message}`)
        }
      }
      let claimsBackfilledAt = previousRow?.claims_backfilled_at ?? null
      if (opts.backfill || !claimsBackfilledAt) {
        try {
          await this.data.backfillClaims(orgId, sellerId, cfg.measurement.longPeriodDays)
          claimsBackfilledAt = new Date().toISOString()
        } catch (err) {
          this.logger.warn(`[recalc] backfill de reclamações falhou seller=${sellerId}: ${(err as Error).message}`)
        }
      }

      const [counts, officialRow] = await Promise.all([
        this.data.fetchCounts(orgId, sellerId, now, cfg.measurement.shortPeriodDays, cfg.measurement.longPeriodDays),
        this.data.fetchOfficialRow(orgId, sellerId),
      ])
      const input: ReputationInput = {
        accountId: sellerId, orgId, asOf: now,
        short: counts.short, long: counts.long,
        windowExits: counts.windowExits, coverage: counts.coverage,
        official: officialFromRow(officialRow),
      }

      const result: StoredResult = {
        active:   computeReputation(input, active, now),
        upcoming: upcoming && upcoming.name !== active.name ? computeReputation(input, upcoming, now) : null,
        counts:   { short: counts.short, long: counts.long, windowExits: counts.windowExits },
      }

      const divergence = this.collectDivergence(result.active)
      if (Object.keys(divergence).length > 0) {
        this.logger.warn(`[recalc] divergência local×oficial seller=${sellerId}: ${JSON.stringify(divergence)}`)
      }

      await this.persistCurrent(orgId, sellerId, result, divergence, { cancelBackfilledAt, claimsBackfilledAt }, now)
      await this.persistSnapshot(orgId, sellerId, result.active, date, now)

      const prev = previousRow?.result?.active ?? null
      const detected = this.detectEvents(prev, result.active, conn.nickname)
      await this.persistEventsAndAlerts(orgId, sellerId, conn.nickname, detected)

      this.events?.emitToOrg(orgId, 'reputation:updated', {
        seller_id:          sellerId,
        overall_level:      result.active.overallLevel,
        risk_level:         result.active.riskLevel,
        measurement_period: result.active.measurementPeriod,
        calculated_at:      result.active.calculatedAt,
        reason:             opts.reason ?? 'manual',
      })

      this.logger.log(
        `[recalc:${opts.reason ?? 'manual'}] seller=${sellerId} período=${result.active.measurementPeriod}d ` +
        `vendas60=${result.active.salesLast60Days} faixa=${result.active.overallLevel} risco=${result.active.riskLevel} ` +
        `eventos=${detected.length} ${Date.now() - t0}ms`,
      )

      return {
        seller_id: sellerId, nickname: conn.nickname, status: 'ready',
        calculated_at: result.active.calculatedAt, cancel_backfilled_at: cancelBackfilledAt, last_error: null,
        active: result.active, upcoming: result.upcoming,
      }
    } catch (err) {
      const msg = (err as Error).message
      await supabaseAdmin
        .from('ml_reputation_current')
        .update({ last_error: msg.slice(0, 500), dirty_since: null, updated_at: new Date().toISOString() })
        .eq('organization_id', orgId)
        .eq('seller_id', sellerId)
      throw err
    } finally {
      this.inflight.delete(key)
    }
  }

  async recalculateAll(orgId: string, opts: { reason?: string; syncOfficial?: boolean } = {}): Promise<AccountView[]> {
    const conns = await this.data.listConnections(orgId)
    const out: AccountView[] = []
    for (const c of conns) {
      try {
        out.push(await this.recalculate(orgId, c.seller_id, opts))
      } catch (err) {
        out.push({
          seller_id: c.seller_id, nickname: c.nickname, status: 'error', calculated_at: null,
          cancel_backfilled_at: null, last_error: (err as Error).message, active: null, upcoming: null,
        })
      }
    }
    return out
  }

  // ── Leitura ───────────────────────────────────────────────────────────────

  async getDashboard(orgId: string): Promise<DashboardView> {
    const now  = new Date()
    const date = toSaoPauloDate(now)
    const [conns, rows, activeRule, upcomingRule, worsened] = await Promise.all([
      this.data.listConnections(orgId),
      this.fetchCurrentRows(orgId),
      this.rules.getActive(date),
      this.rules.getUpcoming(date),
      this.fetchRecentlyWorsened(orgId, WORSENED_WINDOW_H),
    ])
    const byId = new Map(rows.map(r => [Number(r.seller_id), r]))

    const accounts: AccountView[] = conns.map(c => {
      const row = byId.get(c.seller_id)
      if (!row) {
        // Nunca calculado: dispara em background e devolve "pendente".
        this.scheduleRecalc(orgId, c.seller_id, 'first_load')
        return { seller_id: c.seller_id, nickname: c.nickname, status: 'pending', calculated_at: null, cancel_backfilled_at: null, last_error: null, active: null, upcoming: null }
      }
      return this.rowToView(row, c.nickname)
    })

    const summary: DashboardView['summary'] = { total: accounts.length, healthy: 0, attention: 0, critical: 0, near_period_switch: 0, worsened_recently: 0, pending: 0 }
    for (const a of accounts) {
      if (!a.active) { summary.pending++; continue }
      const bucket = classifyAccount(a.active.overallLevel, a.active.riskLevel)
      summary[bucket]++
      if (isNearPeriodSwitch(a.active)) summary.near_period_switch++
      if (worsened.has(a.seller_id)) summary.worsened_recently++
    }

    const pick = (r: ReputationRuleSet | null) => r
      ? { name: r.name, effectiveFrom: r.effectiveFrom, effectiveUntil: r.effectiveUntil, config: r.config, notes: r.notes ?? null }
      : null

    return {
      generated_at: now.toISOString(),
      rules: { active: pick(activeRule)!, upcoming: pick(upcomingRule && upcomingRule.name !== activeRule.name ? upcomingRule : null) },
      summary,
      accounts,
    }
  }

  async getAccount(orgId: string, sellerId: number): Promise<AccountView> {
    const conn = await this.data.assertAccountInOrg(orgId, sellerId)
    const row = await this.fetchCurrentRow(orgId, sellerId)
    if (!row) {
      this.scheduleRecalc(orgId, sellerId, 'first_load')
      return { seller_id: sellerId, nickname: conn.nickname, status: 'pending', calculated_at: null, cancel_backfilled_at: null, last_error: null, active: null, upcoming: null }
    }
    return this.rowToView(row, conn.nickname)
  }

  async getHistory(orgId: string, sellerId: number, days: number) {
    await this.data.assertAccountInOrg(orgId, sellerId)
    const since = toSaoPauloDate(new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000))
    const { data, error } = await supabaseAdmin
      .from('ml_reputation_snapshots')
      .select('snapshot_date, rule_set_name, measurement_period, sales_60d, sales_365d, sales_considered, cancellation_count, cancellation_pct, cancellation_level, shipping_issue_count, shipping_issue_pct, shipping_issue_level, claim_count, claim_pct, claim_level, official_level_id, official_cancellation_pct, official_claims_pct, official_delayed_pct, overall_level, risk_level, calculated_at')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .gte('snapshot_date', since)
      .order('snapshot_date', { ascending: true })
    if (error) throw new Error(error.message)
    return data ?? []
  }

  async getEvents(orgId: string, sellerId: number | null, limit: number) {
    if (sellerId != null) await this.data.assertAccountInOrg(orgId, sellerId)
    let q = supabaseAdmin
      .from('ml_reputation_events')
      .select('id, seller_id, event_type, metric, from_value, to_value, severity, payload, created_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(Math.min(200, Math.max(1, limit)))
    if (sellerId != null) q = q.eq('seller_id', sellerId)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data ?? []
  }

  /** Simulação "e se" — recalcula em memória a partir das contagens do último cálculo. Não grava nada. */
  async simulate(orgId: string, sellerId: number, sim: SimulationInput, ruleName?: string): Promise<{ base: ReputationResult; simulated: ReputationResult }> {
    await this.data.assertAccountInOrg(orgId, sellerId)
    const row = await this.fetchCurrentRow(orgId, sellerId)
    if (!row?.result?.active || !row.result.counts) throw new Error('Conta ainda sem cálculo — aguarde a primeira atualização')
    const base = ruleName && row.result.upcoming?.ruleSet.name === ruleName ? row.result.upcoming : row.result.active
    const ruleSet = await this.rules.getByName(base.ruleSet.name)
    if (!ruleSet) throw new Error(`Regra ${base.ruleSet.name} não encontrada`)
    const input: ReputationInput = {
      accountId: sellerId, orgId, asOf: new Date(base.dataAsOf),
      short: row.result.counts.short, long: row.result.counts.long,
      coverage: base.coverage, official: null,
    }
    return { base, simulated: simulateReputation(input, ruleSet, sim) }
  }

  async listRules() {
    return (await this.rules.listRuleSets()).map(r => ({
      name: r.name, effectiveFrom: r.effectiveFrom, effectiveUntil: r.effectiveUntil, config: r.config, isBuiltin: r.isBuiltin, notes: r.notes ?? null,
    }))
  }

  // ── Internos: persistência ────────────────────────────────────────────────

  private async fetchCurrentRow(orgId: string, sellerId: number): Promise<CurrentRow | null> {
    const { data } = await supabaseAdmin
      .from('ml_reputation_current')
      .select('*')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .maybeSingle()
    return (data as CurrentRow | null) ?? null
  }

  private async fetchCurrentRows(orgId: string): Promise<CurrentRow[]> {
    const { data } = await supabaseAdmin
      .from('ml_reputation_current')
      .select('*')
      .eq('organization_id', orgId)
    return (data ?? []) as CurrentRow[]
  }

  private rowToView(row: CurrentRow, nickname: string | null): AccountView {
    return {
      seller_id:            Number(row.seller_id),
      nickname,
      status:               row.result?.active ? 'ready' : 'error',
      calculated_at:        row.calculated_at,
      cancel_backfilled_at: row.cancel_backfilled_at,
      last_error:           row.last_error,
      active:               row.result?.active ?? null,
      upcoming:             row.result?.upcoming ?? null,
    }
  }

  private async persistCurrent(
    orgId: string, sellerId: number, result: StoredResult, divergence: Record<string, unknown>,
    backfills: { cancelBackfilledAt: string | null; claimsBackfilledAt: string | null }, now: Date,
  ): Promise<void> {
    const a = result.active
    const { error } = await supabaseAdmin
      .from('ml_reputation_current')
      .upsert({
        organization_id:      orgId,
        seller_id:            sellerId,
        rule_set_name:        a.ruleSet.name,
        measurement_period:   a.measurementPeriod,
        sales_60d:            a.salesLast60Days,
        sales_365d:           a.salesLast365Days,
        overall_level:        a.overallLevel,
        risk_level:           a.riskLevel,
        result,
        official:             a.official,
        divergence:           Object.keys(divergence).length > 0 ? divergence : null,
        calculated_at:        a.calculatedAt,
        data_as_of:           a.dataAsOf,
        dirty_since:          null,
        cancel_backfilled_at: backfills.cancelBackfilledAt,
        claims_backfilled_at: backfills.claimsBackfilledAt,
        last_error:           null,
        updated_at:           now.toISOString(),
      }, { onConflict: 'organization_id,seller_id' })
    if (error) throw new Error(`ml_reputation_current upsert: ${error.message}`)
  }

  private async persistSnapshot(orgId: string, sellerId: number, a: ReputationResult, date: string, now: Date): Promise<void> {
    const m = a.metrics
    const { error } = await supabaseAdmin
      .from('ml_reputation_snapshots')
      .upsert({
        organization_id:           orgId,
        seller_id:                 sellerId,
        snapshot_date:             date,
        rule_set_name:             a.ruleSet.name,
        measurement_period:        a.measurementPeriod,
        sales_60d:                 a.salesLast60Days,
        sales_365d:                a.salesLast365Days,
        sales_considered:          a.salesConsidered,
        cancellation_count:        m.cancellations.affectedSales,
        cancellation_pct:          round4(m.cancellations.percentage),
        cancellation_level:        m.cancellations.level,
        shipping_issue_count:      m.incorrectShipments.affectedSales,
        shipping_issue_pct:        round4(m.incorrectShipments.percentage),
        shipping_issue_level:      m.incorrectShipments.level,
        claim_count:               m.claims.affectedSales,
        claim_pct:                 round4(m.claims.percentage),
        claim_level:               m.claims.level,
        official_level_id:         a.official?.levelId ?? null,
        official_cancellation_pct: round4(a.official?.cancellations.percentage ?? null),
        official_claims_pct:       round4(a.official?.claims.percentage ?? null),
        official_delayed_pct:      round4(a.official?.delayedHandling.percentage ?? null),
        overall_level:             a.overallLevel,
        risk_level:                a.riskLevel,
        calculated_at:             now.toISOString(),
      }, { onConflict: 'organization_id,seller_id,snapshot_date' })
    if (error) throw new Error(`ml_reputation_snapshots upsert: ${error.message}`)
  }

  private collectDivergence(a: ReputationResult): Record<string, { local: number | null; official: number | null; delta: number }> {
    const out: Record<string, { local: number | null; official: number | null; delta: number }> = {}
    for (const k of METRIC_KEYS) {
      const m = a.metrics[k]
      if (m.divergence?.significant) {
        out[k] = { local: m.percentage, official: m.official?.percentage ?? null, delta: m.divergence.deltaPercentagePoints }
      }
    }
    return out
  }

  // ── Internos: eventos + alertas ───────────────────────────────────────────

  private detectEvents(prev: ReputationResult | null, cur: ReputationResult, nickname: string | null): DetectedEvent[] {
    const out: DetectedEvent[] = []
    const name = nickname ?? `Conta ${cur.accountId}`
    const threshold = cur.nextMeasurementThreshold

    // Mudança de período — só quando há cálculo anterior (senão é a 1ª carga).
    if (prev && prev.measurementPeriod !== cur.measurementPeriod) {
      const toShort = cur.measurementPeriod === cur.shortPeriodDays
      out.push({
        event_type: 'period_changed', metric: null,
        from_value: String(prev.measurementPeriod), to_value: String(cur.measurementPeriod),
        severity: 'info', dedupe_key: `period_changed:${prev.measurementPeriod}>${cur.measurementPeriod}`, cooldown_h: 24,
        payload: { sales_60d: cur.salesLast60Days, threshold },
        alert: {
          category: 'reputation_period_changed', score: 35,
          summary_pt: toShort
            ? `A conta ${name} atingiu ${threshold} vendas nos últimos ${cur.shortPeriodDays} dias e agora está sendo avaliada pela janela de ${cur.shortPeriodDays} dias.`
            : `A conta ${name} caiu abaixo de ${threshold} vendas nos últimos ${cur.shortPeriodDays} dias e voltou à avaliação de ${cur.longPeriodDays} dias.`,
          suggestion_pt: toShort
            ? `Na janela de ${cur.shortPeriodDays} dias os limites são mais rígidos — confira as margens de cada indicador.`
            : `Os indicadores passam a usar o denominador de ${cur.longPeriodDays} dias; revise as faixas no painel de reputação.`,
        },
      })
    }

    for (const k of METRIC_KEYS) {
      const pm = prev?.metrics[k]
      const cm = cur.metrics[k]
      const label = METRIC_LABEL_PT[k]

      // Troca de faixa
      if (pm && pm.level !== 'unknown' && cm.level !== 'unknown' && pm.level !== cm.level) {
        const worse = levelRank(cm.level) > levelRank(pm.level)
        const severity: AlertSeverity = !worse ? 'info' : (cm.level === 'yellow' ? 'warning' : 'critical')
        out.push({
          event_type: 'level_changed', metric: k, from_value: pm.level, to_value: cm.level, severity,
          dedupe_key: `level_changed:${k}:${pm.level}>${cm.level}`, cooldown_h: 24,
          payload: { percentage: cm.percentage, affected: cm.affectedSales, total: cm.totalSales, period: cur.measurementPeriod },
          alert: worse ? {
            category: 'reputation_dropped', score: cm.level === 'red' ? 95 : cm.level === 'orange' ? 85 : 65,
            summary_pt: `A conta ${name} passou de ${LEVEL_LABEL_PT[pm.level]} para ${LEVEL_LABEL_PT[cm.level]} em ${label}: ${fmtPct(cm.percentage)} (${cm.affectedSales} de ${cm.totalSales} vendas, janela de ${cur.measurementPeriod} dias).`,
            suggestion_pt: cm.salesToRecoverGreen != null && cm.salesToRecoverGreen > 0
              ? `São necessárias aproximadamente ${cm.salesToRecoverGreen} vendas sem novas ocorrências para voltar ao Verde. Abra o painel de reputação para ver o detalhe.`
              : 'Abra o painel de reputação para ver o detalhe e agir antes da próxima faixa.',
          } : undefined,
        })
      }

      // Aproximação do limite (entra em alto/crítico sem ter trocado de faixa)
      const wasNear = pm ? isNearRisk(pm.riskLevel) : false
      const isNear  = isNearRisk(cm.riskLevel) && cm.level !== 'red'
      if (isNear && !wasNear && cm.currentLimit != null) {
        out.push({
          event_type: 'near_limit', metric: k, from_value: pm?.riskLevel ?? null, to_value: cm.riskLevel,
          severity: cm.riskLevel === 'critical' ? 'critical' : 'warning',
          dedupe_key: `near_limit:${k}:${cm.level}:${cm.riskLevel}`, cooldown_h: 72,
          payload: { percentage: cm.percentage, limit: cm.currentLimit, margin_pp: cm.distancePercentagePoints, remaining_static: cm.remainingOccurrencesStatic },
          alert: {
            category: 'reputation_dropped', score: cm.riskLevel === 'critical' ? 80 : 60,
            summary_pt: `A conta ${name} está próxima do limite de ${label.toLowerCase()}: ${fmtPct(cm.percentage)} com limite ${LEVEL_LABEL_PT[cm.level].toLowerCase()} de ${fmtPct(cm.currentLimit)} (margem de ${fmtPct(cm.distancePercentagePoints).replace('%', ' p.p.')}).`,
            suggestion_pt: cm.remainingOccurrencesStatic != null
              ? `Mantendo o volume atual, cabem aproximadamente ${cm.remainingOccurrencesStatic} ocorrência(s) antes de mudar de faixa.`
              : 'Acompanhe as próximas ocorrências de perto.',
          },
        })
      }
      if (wasNear && !isNearRisk(cm.riskLevel)) {
        out.push({
          event_type: 'back_to_safe', metric: k, from_value: pm?.riskLevel ?? null, to_value: cm.riskLevel,
          severity: 'info', dedupe_key: `back_to_safe:${k}:${cm.riskLevel}`, cooldown_h: 24,
          payload: { percentage: cm.percentage },
        })
      }
    }
    return out
  }

  private async persistEventsAndAlerts(orgId: string, sellerId: number, nickname: string | null, events: DetectedEvent[]): Promise<void> {
    for (const ev of events) {
      try {
        if (await this.hasRecentEvent(orgId, sellerId, ev.dedupe_key, ev.cooldown_h)) continue

        let alertId: string | null = null
        if (ev.alert) {
          const draft: SignalDraft = {
            analyzer:    'ml',
            category:    ev.alert.category,
            severity:    ev.severity,
            score:       ev.alert.score,
            entity_type: null,
            entity_id:   null,
            entity_name: nickname ?? `Conta ${sellerId}`,
            data:        { kind: 'reputation', seller_id: sellerId, event_type: ev.event_type, metric: ev.metric, from: ev.from_value, to: ev.to_value, ...ev.payload },
            summary_pt:    ev.alert.summary_pt,
            suggestion_pt: ev.alert.suggestion_pt,
          }
          const [sig] = await this.signals.insertMany(orgId, [draft])
          alertId = sig?.id ?? null
        }

        const { error } = await supabaseAdmin.from('ml_reputation_events').insert({
          organization_id: orgId,
          seller_id:       sellerId,
          event_type:      ev.event_type,
          metric:          ev.metric,
          from_value:      ev.from_value,
          to_value:        ev.to_value,
          severity:        ev.severity,
          dedupe_key:      ev.dedupe_key,
          payload:         ev.payload,
          alert_signal_id: alertId,
        })
        if (error) this.logger.warn(`[events] insert ${ev.dedupe_key}: ${error.message}`)
      } catch (err) {
        this.logger.warn(`[events] ${ev.dedupe_key}: ${(err as Error).message}`)
      }
    }
  }

  private async hasRecentEvent(orgId: string, sellerId: number, dedupeKey: string, withinHours: number): Promise<boolean> {
    const since = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString()
    const { count } = await supabaseAdmin
      .from('ml_reputation_events')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .eq('dedupe_key', dedupeKey)
      .gte('created_at', since)
    return (count ?? 0) > 0
  }

  private async fetchRecentlyWorsened(orgId: string, hours: number): Promise<Set<number>> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
    const { data } = await supabaseAdmin
      .from('ml_reputation_events')
      .select('seller_id')
      .eq('organization_id', orgId)
      .in('severity', ['warning', 'critical'])
      .gte('created_at', since)
    return new Set(((data ?? []) as Array<{ seller_id: number }>).map(r => Number(r.seller_id)))
  }
}

// ── Helpers puros ─────────────────────────────────────────────────────────

function round4(v: number | null | undefined): number | null {
  return v == null ? null : Math.round(v * 10_000) / 10_000
}

function isNearRisk(r: RiskOrUnknown): boolean {
  return r === 'high' || r === 'critical'
}

export function classifyAccount(level: LevelOrUnknown, risk: RiskOrUnknown): 'healthy' | 'attention' | 'critical' {
  if (level === 'red' || level === 'orange' || risk === 'critical') return 'critical'
  if (level === 'yellow' || risk === 'high') return 'attention'
  return 'healthy'
}

export function isNearPeriodSwitch(a: ReputationResult): boolean {
  if (a.measurementPeriod === a.longPeriodDays) {
    return a.salesUntilShortPeriod > 0 && a.salesUntilShortPeriod <= NEAR_SWITCH_SALES
  }
  return a.periodForecast?.kind === 'may_drop_to_long'
}

export function riskRank(r: RiskOrUnknown): number {
  return r === 'unknown' ? -1 : RISK_ORDER.indexOf(r)
}
