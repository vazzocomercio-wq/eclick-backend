import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { AdsAiService } from '../ads-ai.service'
import { WhatsAppConfigService } from '../../whatsapp/whatsapp-config.service'
import { WhatsAppSender } from '../../whatsapp/whatsapp.sender'

const APP_BASE = process.env.PUBLIC_FRONTEND_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.eclick.com.br'

const SEVERITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 }
const SEVERITY_EMOJI: Record<string, string> = { low: 'ℹ️', medium: '⚠️', high: '🚨', critical: '🔥' }

@Injectable()
export class WhatsAppAlerterService {
  private readonly logger = new Logger(WhatsAppAlerterService.name)

  constructor(
    private readonly settings: AdsAiService,
    private readonly waConfig: WhatsAppConfigService,
    private readonly waSender: WhatsAppSender,
  ) {}

  /** Cron — every 10 minutes. Picks insights with alert_sent=false whose
   * severity is at-or-above the org's configured threshold and the org
   * has WhatsApp alerts enabled with a phone configured. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async tick() {
    try {
      const { data: orgs } = await supabaseAdmin
        .from('ads_ai_settings')
        .select('organization_id, whatsapp_alert_phone, whatsapp_alert_severity')
        .eq('whatsapp_alerts_enabled', true)
        .not('whatsapp_alert_phone', 'is', null)

      if (!orgs?.length) return

      let totalSent = 0
      for (const o of orgs) {
        try {
          const sent = await this.flushForOrg(o.organization_id as string)
          totalSent += sent
        } catch (e: unknown) {
          const err = e as { message?: string }
          this.logger.warn(`[ads-ai.alerter] org=${o.organization_id}: ${err?.message}`)
        }
      }
      if (totalSent > 0) {
        this.logger.log(`[ads-ai.alerter] ${totalSent} alerta(s) enviado(s)`)
      }
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.error(`[ads-ai.alerter.tick] ${err?.message}`)
    }
  }

  /** Send pending alerts for one org. Returns the count actually sent. */
  async flushForOrg(orgId: string): Promise<number> {
    const cfg = await this.settings.getSettings(orgId)
    if (!cfg.whatsapp_alerts_enabled || !cfg.whatsapp_alert_phone) return 0

    const minRank = SEVERITY_RANK[cfg.whatsapp_alert_severity] ?? 3
    const acceptedSeverities = Object.entries(SEVERITY_RANK)
      .filter(([, r]) => r >= minRank)
      .map(([s]) => s)

    const { data: pending } = await supabaseAdmin
      .from('ads_ai_insights')
      .select('id, type, severity, campaign_name, title, description, recommendation, estimated_impact')
      .eq('organization_id', orgId)
      .eq('status', 'open')
      .eq('alert_sent', false)
      .in('severity', acceptedSeverities)
      .order('created_at', { ascending: false })
      .limit(20)

    if (!pending?.length) return 0

    const waCfg = await this.waConfig.findActive()
    if (!waCfg) {
      this.logger.warn(`[ads-ai.alerter] org=${orgId}: sem whatsapp_config ativa — alerts não enviados`)
      return 0
    }

    const phoneDigits = (cfg.whatsapp_alert_phone ?? '').replace(/\D/g, '')
    if (!phoneDigits) return 0

    let sent = 0
    for (const ins of pending) {
      const text = this.composeMessage(ins as Record<string, unknown>)
      const r = await this.waSender.sendTextMessage({ phone: phoneDigits, message: text, waConfig: waCfg })
      if (!r.success) {
        this.logger.warn(`[ads-ai.alerter] envio falhou: ${r.error}`)
        continue
      }
      await supabaseAdmin
        .from('ads_ai_insights')
        .update({ alert_sent: true })
        .eq('id', ins.id)
      sent++
    }
    return sent
  }

  private composeMessage(ins: Record<string, unknown>): string {
    const sev   = (ins.severity as string) ?? 'medium'
    const emoji = SEVERITY_EMOJI[sev] ?? '🔔'
    const title = (ins.title as string) ?? '(sem título)'
    const desc  = (ins.description as string) ?? ''
    const rec   = (ins.recommendation as string) ?? ''
    const imp   = (ins.estimated_impact as string | null) ?? null
    const link  = `${APP_BASE}/dashboard/ads/inteligencia#i-${ins.id}`

    return [
      `${emoji} *e-Click | ${title}*`,
      '',
      desc,
      '',
      `💡 ${rec}`,
      ...(imp ? ['', `📊 ${imp}`] : []),
      '',
      `🔗 ${link}`,
    ].join('\n')
  }
}
