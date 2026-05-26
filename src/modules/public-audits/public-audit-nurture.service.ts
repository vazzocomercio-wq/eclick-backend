import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { EmailSenderService } from '../messaging/email-sender.service'
import { ActiveBridgeClient } from '../active-bridge/active-bridge.client'
import { emailFor, whatsappFor, type NurtureStep } from './public-audit-nurture.templates'

const ORG_ID = () => process.env.PUBLIC_AUDIT_ORG_ID ?? '4ef1aabd-c209-40b0-b034-ef69dcb66833'
const RESULT_BASE = 'https://eclick.app.br/auditoria-gratis/resultado'
const UNSUB_BASE = 'https://eclick.app.br/auditoria-gratis/descadastro'
const NURTURE_PLAN: Array<{ step: NurtureStep; days: number }> = [
  { step: 'd0', days: 0 }, { step: 'd2', days: 2 }, { step: 'd5', days: 5 },
  { step: 'd8', days: 8 }, { step: 'd10', days: 10 },
]

interface DueMsg { id: string; audit_id: string; step: NurtureStep; channel: 'email' | 'whatsapp' }

interface AuditRow {
  name: string; email: string; whatsapp: string | null
  geo_score: number | null; result_json: { band?: string; topProblems?: Array<{ title: string }>; skipped?: unknown } | null
  status: string; opted_out: boolean
}

/**
 * Nutrição da Auditoria GEO (Sprint 2c). Drip D+0..D+10 orquestrado no SaaS
 * (Active não tem motor de email), refletido no funil "Captação GEO" do Active.
 *
 * scheduleFor() é chamado pelo worker quando a auditoria fica 'done' (com nota
 * real). @Cron(5min) envia os vencidos: email via Resend + WhatsApp via bridge.
 * Tudo best-effort — falha de envio nunca derruba a fila. CAS evita envio duplo
 * entre instâncias. Limpeza do audit (cascade) limpa a agenda.
 */
@Injectable()
export class PublicAuditNurtureService {
  private readonly logger = new Logger(PublicAuditNurtureService.name)
  private ticking = false

  constructor(
    private readonly emailSender: EmailSenderService,
    private readonly bridge: ActiveBridgeClient,
  ) {}

  /** Agenda os 5 toques (email sempre; WhatsApp se houver número). Idempotente. */
  async scheduleFor(auditId: string): Promise<void> {
    try {
      const { data } = await supabaseAdmin
        .from('public_audits')
        .select('whatsapp, created_at, email')
        .eq('id', auditId)
        .maybeSingle()
      if (!data) return
      const { whatsapp, created_at, email } = data as { whatsapp: string | null; created_at: string; email: string }

      // Respeita opt-out prévio (por email) — não agenda pra quem já saiu.
      const { data: opted } = await supabaseAdmin
        .from('public_audits')
        .select('id').eq('email', email).eq('opted_out', true).limit(1).maybeSingle()
      if (opted) { this.logger.log(`[nurture] scheduleFor ${auditId} pulado — email opted out`); return }

      const base = new Date(created_at).getTime()

      const rows: Array<{ audit_id: string; step: string; channel: string; scheduled_at: string; status: string }> = []
      for (const { step, days } of NURTURE_PLAN) {
        const at = new Date(base + days * 86_400_000).toISOString()
        rows.push({ audit_id: auditId, step, channel: 'email', scheduled_at: at, status: 'pending' })
        if (whatsapp) rows.push({ audit_id: auditId, step, channel: 'whatsapp', scheduled_at: at, status: 'pending' })
      }
      await supabaseAdmin
        .from('public_audit_messages')
        .upsert(rows, { onConflict: 'audit_id,step,channel', ignoreDuplicates: true })
    } catch (e) {
      this.logger.warn(`[nurture] scheduleFor ${auditId} falhou: ${(e as Error).message}`)
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'public-audit-nurture' })
  async tick(): Promise<void> {
    // Kill-switch sem deploy: setar PUBLIC_AUDIT_NURTURE_DISABLED=true no Railway.
    if (process.env.PUBLIC_AUDIT_NURTURE_DISABLED === 'true') return
    if (this.ticking) return
    this.ticking = true
    try {
      const { data } = await supabaseAdmin
        .from('public_audit_messages')
        .select('id, audit_id, step, channel')
        .eq('status', 'pending')
        .lte('scheduled_at', new Date().toISOString())
        .order('scheduled_at', { ascending: true })
        .limit(20)
      for (const m of (data ?? []) as DueMsg[]) await this.claimAndSend(m)
    } catch (e) {
      this.logger.warn(`[nurture] tick falhou: ${(e as Error).message}`)
    } finally {
      this.ticking = false
    }
  }

  /** CAS pra não enviar duplicado entre instâncias. */
  private async claimAndSend(m: DueMsg): Promise<void> {
    const { data: claimed } = await supabaseAdmin
      .from('public_audit_messages')
      .update({ status: 'sending' })
      .eq('id', m.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claimed) return
    await this.send(m)
  }

  private async send(m: DueMsg): Promise<void> {
    const { data } = await supabaseAdmin
      .from('public_audits')
      .select('name, email, whatsapp, geo_score, result_json, status, opted_out')
      .eq('id', m.audit_id)
      .maybeSingle()
    const audit = data as AuditRow | null

    // Sem auditoria pronta / sem nota / página pulada → não nutre.
    if (!audit || audit.status !== 'done' || !audit.result_json || audit.result_json.skipped) {
      return this.mark(m.id, 'skipped', 'audit não-elegível')
    }
    // Descadastro (LGPD) → não envia mais nada.
    if (audit.opted_out) {
      return this.mark(m.id, 'skipped', 'opted out')
    }
    // Guarda contra emails de teste do smoke.
    if (audit.email.endsWith('@teste-eclick.com')) {
      return this.mark(m.id, 'skipped', 'email de teste')
    }

    const ctx = {
      firstName: (audit.name || 'tudo bem').trim().split(/\s+/)[0],
      score: audit.geo_score ?? 0,
      band: (audit.result_json.band as 'red' | 'yellow' | 'green') ?? 'red',
      topProblems: (audit.result_json.topProblems ?? []).slice(0, 3).map((p) => p.title),
      resultUrl: `${RESULT_BASE}/${m.audit_id}`,
      unsubUrl: `${UNSUB_BASE}?aid=${m.audit_id}`,
    }

    try {
      if (m.channel === 'email') {
        const { subject, html } = emailFor(m.step, ctx)
        const r = await this.emailSender.sendEmail({ orgId: ORG_ID(), to: audit.email, subject, body: html })
        if (!r.success) return this.mark(m.id, 'failed', r.error ?? 'email falhou')
      } else {
        if (!audit.whatsapp) return this.mark(m.id, 'skipped', 'sem whatsapp')
        const r = await this.bridge.sendDirectMessage({
          organization_id: ORG_ID(), phone: audit.whatsapp,
          message: whatsappFor(m.step, ctx), dedup_key: `pubaudit:${m.audit_id}:${m.step}`,
        })
        if (r.skipped_no_bridge) return this.mark(m.id, 'skipped', r.error ?? 'whatsapp indisponível')
      }
      await this.mark(m.id, 'sent')

      // No D+0 (primeiro toque) move o card do funil pra "Nutrição".
      if (m.step === 'd0' && m.channel === 'email') {
        void this.bridge.moveCard({
          organization_id: ORG_ID(), dedup_key: `public_audit:${m.audit_id}`, to_stage_name: 'Nutrição',
        }).catch(() => undefined)
      }
    } catch (e) {
      await this.mark(m.id, 'failed', (e as Error).message)
    }
  }

  private async mark(id: string, status: 'sent' | 'failed' | 'skipped', error?: string): Promise<void> {
    await supabaseAdmin.from('public_audit_messages').update({
      status, sent_at: status === 'sent' ? new Date().toISOString() : null, error: error ? error.slice(0, 500) : null,
    }).eq('id', id)
  }
}
