import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { AlertHubConfigService } from './alert-hub-config.service'
import { AlertSignalsService } from './alert-signals.service'
import { AlertDeliveriesService } from './alert-deliveries.service'
import type {
  AlertSignal, AlertDelivery, DeliveryDraft,
} from './analyzers/analyzers.types'

interface RoutingRuleRow {
  id:          string
  department:  string
  analyzer:    string
  categories:  string[]
  min_score:   number
  enabled:     boolean
}

interface ManagerRow {
  id:         string
  department: string
  status:     string
  verified:   boolean
}

interface QuietHours {
  enabled: boolean
  start:   string  // 'HH:MM'
  end:     string  // 'HH:MM'
}

interface DigestConfig {
  morning?:   string
  afternoon?: string
  evening?:   string
  timezone?:  string
}

interface HubConfigShape {
  enabled:                        boolean
  quiet_hours:                    QuietHours
  digest_config:                  DigestConfig
  max_alerts_per_manager_per_day: number
  min_interval_minutes:           number
}

/**
 * AlertEngine — orquestra signal → routing → deliveries.
 *
 * process(signal) faz pra cada signal:
 *   1. Carrega config do hub. Se enabled=false → skip.
 *   2. Busca routing rules da org com (analyzer = signal.analyzer OR '*'),
 *      enabled=true, min_score <= signal.score, e categories vazia OU
 *      contendo signal.category.
 *   3. Coleta departments alvo dessas rules.
 *   4. Busca managers ativos+verified daqueles depts.
 *   5. Filtra cada manager por anti-spam:
 *      - count_today < max_alerts_per_manager_per_day
 *      - now - last_delivery >= min_interval_minutes
 *      - quiet_hours respeitado, exceto severity='critical'
 *   6. Cria deliveries (status=pending).
 *   7. Marca signal status='dispatched' se gerou delivery; senão 'ignored'.
 *
 * Não envia mensagens — só registra deliveries pra IH-3 consumir.
 */
@Injectable()
export class AlertEngineService {
  private readonly logger = new Logger(AlertEngineService.name)

  constructor(
    private readonly hubCfg:       AlertHubConfigService,
    private readonly signalsSvc:   AlertSignalsService,
    private readonly deliveriesSvc: AlertDeliveriesService,
  ) {}

  /**
   * Processa lista de signals em sequência. Retorna deliveries criadas.
   */
  async processMany(orgId: string, signals: AlertSignal[]): Promise<AlertDelivery[]> {
    const cfg = await this.hubCfg.get(orgId) as HubConfigShape
    if (!cfg.enabled) {
      this.logger.warn(`[engine] org=${orgId} hub disabled — ${signals.length} signals não processados`)
      return []
    }

    const all: AlertDelivery[] = []
    for (const sig of signals) {
      const created = await this.processOne(orgId, sig, cfg)
      all.push(...created)
    }
    this.logger.log(`[engine] org=${orgId} signals=${signals.length} deliveries=${all.length}`)
    return all
  }

  async processOne(orgId: string, signal: AlertSignal, cfg?: HubConfigShape): Promise<AlertDelivery[]> {
    const config = cfg ?? (await this.hubCfg.get(orgId) as HubConfigShape)
    if (!config.enabled) return []

    // 1. Resolve routing rules
    const rules = await this.resolveRules(orgId, signal)
    if (rules.length === 0) {
      await this.signalsSvc.updateStatus(orgId, signal.id, 'ignored')
      this.logger.debug(`[engine] signal=${signal.id} sem rules matching`)
      return []
    }

    const departments = [...new Set(rules.map(r => r.department))]

    // 2. Resolve managers ativos+verified desses depts
    const managers = await this.resolveManagers(orgId, departments)
    if (managers.length === 0) {
      await this.signalsSvc.updateStatus(orgId, signal.id, 'ignored')
      this.logger.debug(`[engine] signal=${signal.id} sem managers ativos pra depts=[${departments.join(',')}]`)
      return []
    }

    // 3. Filtrar por anti-spam + quiet hours
    const drafts: DeliveryDraft[] = []
    const now = new Date()
    const isQuiet = this.inQuietHours(now, config.quiet_hours, config.digest_config?.timezone ?? 'America/Sao_Paulo')
    const skipQuiet = isQuiet && signal.severity !== 'critical'

    for (const m of managers) {
      if (skipQuiet) {
        this.logger.debug(`[engine] manager=${m.id} skip — quiet_hours (severity=${signal.severity})`)
        continue
      }

      const todayCount = await this.deliveriesSvc.countTodayByManager(m.id)
      if (todayCount >= config.max_alerts_per_manager_per_day) {
        this.logger.debug(`[engine] manager=${m.id} skip — max_per_day=${todayCount}`)
        continue
      }

      const last = await this.deliveriesSvc.lastByManager(m.id)
      if (last) {
        const minsSince = (now.getTime() - new Date(last.created_at).getTime()) / 60_000
        if (minsSince < config.min_interval_minutes) {
          this.logger.debug(`[engine] manager=${m.id} skip — min_interval (${Math.round(minsSince)}m < ${config.min_interval_minutes}m)`)
          continue
        }
      }

      drafts.push({
        organization_id: orgId,
        signal_id:       signal.id,
        manager_id:      m.id,
        channel:         'whatsapp',
        delivery_type:   'immediate',
      })
    }

    if (drafts.length === 0) {
      await this.signalsSvc.updateStatus(orgId, signal.id, 'ignored')
      return []
    }

    const deliveries = await this.deliveriesSvc.insertMany(drafts)
    await this.signalsSvc.updateStatus(orgId, signal.id, 'dispatched')
    return deliveries
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async resolveRules(orgId: string, signal: AlertSignal): Promise<RoutingRuleRow[]> {
    const { data, error } = await supabaseAdmin
      .from('alert_routing_rules')
      .select('*')
      .eq('organization_id', orgId)
      .eq('enabled', true)
      .in('analyzer', [signal.analyzer, '*'])
      .lte('min_score', signal.score)
    if (error) throw new BadRequestException(error.message)

    const rows = (data ?? []) as RoutingRuleRow[]
    return rows.filter(r =>
      !r.categories || r.categories.length === 0 || r.categories.includes(signal.category),
    )
  }

  private async resolveManagers(orgId: string, departments: string[]): Promise<ManagerRow[]> {
    if (departments.length === 0) return []
    const { data, error } = await supabaseAdmin
      .from('alert_managers')
      .select('id, department, status, verified')
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .eq('verified', true)
      .in('department', departments)
    if (error) throw new BadRequestException(error.message)
    return (data ?? []) as ManagerRow[]
  }

  private inQuietHours(now: Date, qh: QuietHours, tz: string): boolean {
    if (!qh?.enabled) return false
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    })
    const parts = fmt.formatToParts(now)
    const hh = parts.find(p => p.type === 'hour')?.value   ?? '00'
    const mm = parts.find(p => p.type === 'minute')?.value ?? '00'
    const cur = `${hh}:${mm}`
    // intervalo cruza meia-noite (ex: 22:00 → 07:00)
    if (qh.start > qh.end) return cur >= qh.start || cur < qh.end
    return cur >= qh.start && cur < qh.end
  }
}
