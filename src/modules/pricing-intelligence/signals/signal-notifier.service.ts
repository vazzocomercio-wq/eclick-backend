import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { WhatsAppConfigService } from '../../whatsapp/whatsapp-config.service'
import { WhatsAppSender } from '../../whatsapp/whatsapp.sender'
import { NotificationSettingsService } from './notification-settings.service'
import { PricingSignal, Severity, NotificationSettings } from './types'

const SEV_EMOJI: Record<Severity, string> = {
  critical: '🔴', high: '🟠', medium: '🟡', low: '🟢',
}

const SIG_DIRECTION: Record<string, string> = {
  decrease_price: 'baixar',
  increase_price: 'subir',
  do_not_touch:   'não mexer',
  review_needed:  'revisão manual',
  low_confidence: 'baixa confiança',
}

const RADAR_URL = 'https://eclick.app.br/dashboard/pricing/analise'

/** Envia notificações WhatsApp pra alertas pendentes. Respeita
 * quiet_hours, weekends, rate limits. Suporta agrupamento (junta N
 * sinais em 1 mensagem). */
@Injectable()
export class SignalNotifierService {
  private readonly logger = new Logger(SignalNotifierService.name)

  constructor(
    private readonly settings: NotificationSettingsService,
    private readonly waConfig: WhatsAppConfigService,
    private readonly waSender: WhatsAppSender,
  ) {}

  /** Notifica TODAS as orgs com whatsapp_enabled. Chamado pelo cron
   * pós-scan. Itera orgs em série pra respeitar rate limits separadamente. */
  async notifyAllOrgs(): Promise<{ orgs: number; sent: number; skipped: number; failed: number }> {
    const stats = { orgs: 0, sent: 0, skipped: 0, failed: 0 }
    const { data: orgs } = await supabaseAdmin
      .from('pricing_notification_settings').select('organization_id')
      .eq('whatsapp_enabled', true)
    for (const o of orgs ?? []) {
      stats.orgs++
      const r = await this.notifyOrg(o.organization_id as string)
      stats.sent    += r.sent
      stats.skipped += r.skipped
      stats.failed  += r.failed
    }
    return stats
  }

  /** Processa pendentes de 1 org. Returns counts. */
  async notifyOrg(orgId: string): Promise<{ sent: number; skipped: number; failed: number }> {
    const cfg = await this.settings.getOrCreate(orgId)
    if (!cfg.whatsapp_enabled || !cfg.whatsapp_phone) {
      await this.markSkipped(orgId, 'disabled')
      return { sent: 0, skipped: 0, failed: 0 }
    }

    // Quiet hours / weekend check
    if (this.isQuietNow(cfg)) {
      await this.markSkipped(orgId, 'quiet_hours')
      return { sent: 0, skipped: 0, failed: 0 }
    }
    if (this.isWeekend() && !cfg.notify_weekends) {
      await this.markSkipped(orgId, 'weekend')
      return { sent: 0, skipped: 0, failed: 0 }
    }

    // Rate limits — conta logs recentes
    const sentThisHour = await this.countSentSince(orgId, 60 * 60_000)
    const sentToday    = await this.countSentSince(orgId, 24 * 60 * 60_000)
    if (sentThisHour >= cfg.max_per_hour) return { sent: 0, skipped: 0, failed: 0 }
    if (sentToday    >= cfg.max_per_day)  return { sent: 0, skipped: 0, failed: 0 }

    // Busca pendentes filtrando por severities/types do settings
    const { data: pending } = await supabaseAdmin
      .from('pricing_signals').select('*')
      .eq('organization_id', orgId)
      .eq('notification_status', 'pending')
      .eq('status', 'active')
      .in('severity', cfg.notify_severities ?? ['critical', 'high'])
      .in('signal_type', cfg.notify_signal_types ?? ['decrease_price', 'increase_price'])
      .order('severity', { ascending: false })
      .limit(50)

    const sigs = (pending ?? []) as PricingSignal[]
    if (sigs.length === 0) return { sent: 0, skipped: 0, failed: 0 }

    const wa = await this.waConfig.findActive()
    if (!wa) {
      this.logger.warn(`[pricing.notifier] WhatsApp Business não configurado pra org=${orgId}`)
      return { sent: 0, skipped: 0, failed: 0 }
    }

    let sent = 0, failed = 0
    if (cfg.group_notifications) {
      // Mensagem única agrupada
      const message = this.buildGroupedMessage(sigs)
      const result = await this.waSender.sendTextMessage({
        phone:    cfg.whatsapp_phone,
        message,
        waConfig: wa,
      })
      const ids = sigs.map(s => s.id!).filter(Boolean)
      await this.logSend(orgId, cfg.whatsapp_phone, ids, message, result.success, result.error)
      if (result.success) {
        sent = ids.length
        await this.markNotified(ids, 'sent')
      } else {
        failed = ids.length
        await this.markNotified(ids, 'failed')
      }
    } else {
      // 1 mensagem por sinal — respeita rate limit incremental
      let inHour = sentThisHour
      let inDay  = sentToday
      for (const sig of sigs) {
        if (inHour >= cfg.max_per_hour) break
        if (inDay  >= cfg.max_per_day)  break
        const message = this.buildSingleMessage(sig)
        const result = await this.waSender.sendTextMessage({
          phone:    cfg.whatsapp_phone,
          message,
          waConfig: wa,
        })
        await this.logSend(orgId, cfg.whatsapp_phone, [sig.id!], message, result.success, result.error)
        if (result.success) {
          sent++; inHour++; inDay++
          await this.markNotified([sig.id!], 'sent')
        } else {
          failed++
          await this.markNotified([sig.id!], 'failed')
        }
        await new Promise(r => setTimeout(r, 100)) // 10/s
      }
    }

    this.logger.log(`[pricing.notifier] org=${orgId} sent=${sent} failed=${failed}`)
    return { sent, skipped: 0, failed }
  }

  // ── builders ─────────────────────────────────────────────────────────────

  private buildGroupedMessage(sigs: PricingSignal[]): string {
    const bySev: Record<Severity, PricingSignal[]> = { critical: [], high: [], medium: [], low: [] }
    for (const s of sigs) bySev[s.severity].push(s)

    const lines: string[] = ['🔔 *e-Click — Alertas de Preço*', '', `Você tem ${sigs.length} sinais pendentes:`, '']
    const sevOrder: Severity[] = ['critical', 'high', 'medium', 'low']
    const sevLabel: Record<Severity, string> = { critical: 'CRÍTICO', high: 'ALTO', medium: 'MÉDIO', low: 'BAIXO' }
    for (const sev of sevOrder) {
      const list = bySev[sev]
      if (list.length === 0) continue
      lines.push(`${SEV_EMOJI[sev]} *${sevLabel[sev]}* (${list.length}):`)
      for (const s of list.slice(0, 8)) {
        const dir = SIG_DIRECTION[s.signal_type] ?? s.signal_type
        const priceMv = s.suggested_price && s.current_price
          ? `R$ ${Number(s.current_price).toFixed(2)} → R$ ${Number(s.suggested_price).toFixed(2)}`
          : ''
        const cleanTitle = s.title.split('—')[0].trim()
        lines.push(`• ${cleanTitle} — ${dir}${priceMv ? ` (${priceMv})` : ''}`)
      }
      if (list.length > 8) lines.push(`  …e mais ${list.length - 8}`)
      lines.push('')
    }
    lines.push(`Acesse o radar:`)
    lines.push(RADAR_URL)
    return lines.join('\n')
  }

  private buildSingleMessage(s: PricingSignal): string {
    const dir = SIG_DIRECTION[s.signal_type] ?? s.signal_type
    const priceMv = s.suggested_price && s.current_price
      ? `\nR$ ${Number(s.current_price).toFixed(2)} → R$ ${Number(s.suggested_price).toFixed(2)}`
      : ''
    return `${SEV_EMOJI[s.severity]} *e-Click — ${dir.toUpperCase()}*\n\n${s.title}${priceMv}\n\nAcesse: ${RADAR_URL}`
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private isQuietNow(cfg: NotificationSettings): boolean {
    if (!cfg.quiet_hours_start || !cfg.quiet_hours_end) return false
    const now = new Date()
    const cur = now.getHours() * 60 + now.getMinutes()
    const start = this.timeToMinutes(cfg.quiet_hours_start)
    const end   = this.timeToMinutes(cfg.quiet_hours_end)
    if (start === end) return false
    // Cross-midnight (ex: 22:00 → 08:00)
    if (start > end) return cur >= start || cur < end
    return cur >= start && cur < end
  }

  private timeToMinutes(t: string): number {
    const [h, m] = t.split(':').map(Number)
    return (h ?? 0) * 60 + (m ?? 0)
  }

  private isWeekend(): boolean {
    const d = new Date().getDay()
    return d === 0 || d === 6
  }

  private async countSentSince(orgId: string, ms: number): Promise<number> {
    const cutoff = new Date(Date.now() - ms).toISOString()
    const { count } = await supabaseAdmin
      .from('pricing_notifications_log').select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId).eq('status', 'sent').gte('created_at', cutoff)
    return count ?? 0
  }

  private async markNotified(ids: string[], status: 'sent' | 'failed'): Promise<void> {
    if (ids.length === 0) return
    await supabaseAdmin
      .from('pricing_signals').update({
        notification_status: status,
        notified_at:         new Date().toISOString(),
        updated_at:          new Date().toISOString(),
      }).in('id', ids)
  }

  private async markSkipped(orgId: string, reason: string): Promise<void> {
    await supabaseAdmin
      .from('pricing_signals').update({
        notification_status: 'skipped',
        updated_at:          new Date().toISOString(),
      })
      .eq('organization_id', orgId)
      .eq('notification_status', 'pending')
      .eq('status', 'active')
    this.logger.log(`[pricing.notifier] org=${orgId} skipped (${reason})`)
  }

  private async logSend(
    orgId: string, phone: string, signalIds: string[],
    body: string, success: boolean, error?: string,
  ): Promise<void> {
    try {
      await supabaseAdmin.from('pricing_notifications_log').insert({
        organization_id: orgId,
        channel:         'whatsapp',
        phone,
        signal_ids:      signalIds,
        message_body:    body,
        status:          success ? 'sent' : 'failed',
        sent_at:         success ? new Date().toISOString() : null,
        error:           error ?? null,
      })
    } catch (e) {
      this.logger.warn(`[pricing.notifier] log insert falhou: ${(e as Error).message}`)
    }
  }
}
