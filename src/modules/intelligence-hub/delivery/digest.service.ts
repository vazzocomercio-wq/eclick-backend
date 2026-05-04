import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { BaileysProvider } from '../../channels/providers/baileys.provider'
import { formatDigestMessage } from './digest-formatter'
import type { AlertSignal, DeliveryType } from '../analyzers/analyzers.types'

const TZ_DEFAULT = 'America/Sao_Paulo'

interface OrgConfig {
  organization_id: string
  enabled:         boolean
  digest_config:   {
    morning?:   string
    afternoon?: string
    evening?:   string
    timezone?:  string
  }
}

interface DeliveryWithJoins {
  id:             string
  organization_id: string
  manager_id:     string
  delivery_type:  DeliveryType
  alert_signals:  AlertSignal | null
  alert_managers: {
    id:         string
    name:       string
    phone:      string
    channel_id: string | null
    status:     string
    verified:   boolean
  } | null
}

const DIGEST_TYPES: DeliveryType[] = ['digest_morning', 'digest_afternoon', 'digest_evening']

/**
 * Cron horário que verifica em quais orgs é hora de enviar digest.
 *
 * Cada org tem timezone (digest_config.timezone). Pra cada org:
 *   1. Calcula HH:MM local na tz
 *   2. Se HH:MM bate com config.digest_config.morning/afternoon/evening:
 *      - Pega deliveries digest_X pending da org
 *      - Agrupa por manager
 *      - Compila msg + envia via Baileys
 *      - Marca todas as deliveries do batch como sent
 *
 * Tolerância: usa janela de match com hora cheia (HH:00). Se config tem
 * "08:30", roda na hora "08" no minuto "30".
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name)
  private isRunning = false

  constructor(private readonly baileys: BaileysProvider) {}

  @Cron('0 * * * *', { name: 'alertHubDigestTick' })
  async tick(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    try {
      await this.processAllOrgs()
    } catch (e) {
      this.logger.error(`[tick] erro inesperado: ${(e as Error).message}`)
    } finally {
      this.isRunning = false
    }
  }

  private async processAllOrgs(): Promise<void> {
    const { data: configs, error } = await supabaseAdmin
      .from('alert_hub_config')
      .select('organization_id, enabled, digest_config')
      .eq('enabled', true)
    if (error) {
      this.logger.error(`[processAll] config query falhou: ${error.message}`)
      return
    }

    const now = new Date()
    let processedOrgs = 0
    let totalSent     = 0

    for (const cfg of (configs ?? []) as OrgConfig[]) {
      const tz = cfg.digest_config?.timezone ?? TZ_DEFAULT
      const window = this.matchDigestWindow(now, cfg.digest_config, tz)
      if (!window) continue

      processedOrgs++
      const sent = await this.processOrgDigest(cfg.organization_id, window)
      totalSent += sent
    }

    if (processedOrgs > 0) {
      this.logger.log(`[tick] orgs com digest=${processedOrgs} mensagens=${totalSent}`)
    }
  }

  private async processOrgDigest(orgId: string, window: DeliveryType): Promise<number> {
    // Pega deliveries da org com tipo da janela atual + status pending
    const { data, error } = await supabaseAdmin
      .from('alert_deliveries')
      .select(`
        id, organization_id, manager_id, delivery_type,
        alert_signals!inner ( id, organization_id, analyzer, category, severity, score,
                              entity_type, entity_id, entity_name, data,
                              summary_pt, suggestion_pt, status, created_at,
                              related_signals, cross_insight, expires_at ),
        alert_managers!inner ( id, name, phone, channel_id, status, verified )
      `)
      .eq('organization_id', orgId)
      .eq('delivery_type', window)
      .eq('status', 'pending')
      .eq('channel', 'whatsapp')
    if (error) {
      this.logger.error(`[org ${orgId}] query falhou: ${error.message}`)
      return 0
    }

    const rows = (data ?? []) as unknown as DeliveryWithJoins[]
    if (rows.length === 0) return 0

    // Agrupa por manager
    const byManager = new Map<string, DeliveryWithJoins[]>()
    for (const row of rows) {
      const arr = byManager.get(row.manager_id) ?? []
      arr.push(row)
      byManager.set(row.manager_id, arr)
    }

    let sent = 0
    for (const [managerId, managerRows] of byManager) {
      const ok = await this.sendDigestForManager(orgId, managerId, window, managerRows)
      if (ok) sent++
    }
    this.logger.log(`[org ${orgId}] window=${window} managers=${byManager.size} sent=${sent}`)
    return sent
  }

  private async sendDigestForManager(
    orgId:       string,
    managerId:   string,
    window:      DeliveryType,
    rows:        DeliveryWithJoins[],
  ): Promise<boolean> {
    const manager = rows[0]?.alert_managers
    if (!manager || !manager.verified || manager.status !== 'active') {
      await this.markBatchFailed(rows, `manager ${managerId} inativo ou não verificado`)
      return false
    }
    if (!manager.channel_id) {
      await this.markBatchFailed(rows, `manager ${managerId} sem channel_id`)
      return false
    }

    const signals = rows.map(r => r.alert_signals).filter((s): s is AlertSignal => !!s)
    if (signals.length === 0) {
      await this.markBatchFailed(rows, 'signals ausentes após join')
      return false
    }

    const body = formatDigestMessage(
      signals,
      window as 'digest_morning' | 'digest_afternoon' | 'digest_evening',
      manager.name,
    )

    try {
      const result = await this.baileys.sendMessage(
        manager.channel_id,
        manager.phone,
        'text',
        { body },
      )
      const ids = rows.map(r => r.id)
      const { error: upErr } = await supabaseAdmin
        .from('alert_deliveries')
        .update({
          status:        'sent',
          sent_at:       new Date().toISOString(),
          wa_message_id: result.message_id ?? null,
          error_message: null,
        })
        .in('id', ids)
      if (upErr) {
        this.logger.error(`[digest] org=${orgId} manager=${managerId} update falhou: ${upErr.message}`)
        return false
      }
      return true
    } catch (e) {
      const msg = (e as Error).message ?? 'unknown'
      await this.markBatchFailed(rows, msg)
      return false
    }
  }

  private async markBatchFailed(rows: DeliveryWithJoins[], reason: string): Promise<void> {
    const ids = rows.map(r => r.id)
    const { error } = await supabaseAdmin
      .from('alert_deliveries')
      .update({ status: 'failed', error_message: reason.slice(0, 500) })
      .in('id', ids)
    if (error) this.logger.error(`[digest] mark failed: ${error.message}`)
    else       this.logger.warn(`[digest] ${ids.length} deliveries failed: ${reason}`)
  }

  /**
   * Verifica se HH:MM atual (na tz da org) bate com alguma janela configurada.
   * Tolerância: matching exato no minuto.
   */
  private matchDigestWindow(
    now: Date,
    cfg: OrgConfig['digest_config'],
    tz:  string,
  ): DeliveryType | null {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    })
    const parts = fmt.formatToParts(now)
    const hh = parts.find(p => p.type === 'hour')?.value   ?? '00'
    const mm = parts.find(p => p.type === 'minute')?.value ?? '00'
    const cur = `${hh}:${mm}`

    if (cfg?.morning   && this.timeApprox(cur, cfg.morning))   return 'digest_morning'
    if (cfg?.afternoon && this.timeApprox(cur, cfg.afternoon)) return 'digest_afternoon'
    if (cfg?.evening   && this.timeApprox(cur, cfg.evening))   return 'digest_evening'
    return null
  }

  /**
   * Hora atual está dentro de janela de 5min após o horário configurado?
   * (cron roda HH:00 — se config diz "08:00" matcha. Se diz "08:05" também,
   * porque cron a cada hora cobre o minuto 0 da próxima.)
   *
   * Implementação simples: compara só hora cheia.
   */
  private timeApprox(cur: string, target: string): boolean {
    const [curH] = cur.split(':')
    const [tgtH] = target.split(':')
    return curH === tgtH
  }

  // ── Manual trigger pra teste ────────────────────────────────────────────────
  async runOnce(orgId: string, window: DeliveryType): Promise<{ sent: number }> {
    if (!DIGEST_TYPES.includes(window)) {
      throw new Error(`window inválida: ${window}`)
    }
    const sent = await this.processOrgDigest(orgId, window)
    return { sent }
  }
}
