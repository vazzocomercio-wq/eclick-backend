/** Sprint M2 — Alertas operacionais de campanha via WhatsApp.
 *
 *  Cron 9h diário (SP) varre todas as configs ativas e dispara:
 *
 *  1. DEADLINE WARNING (escala D-X..D-0):
 *     - Campanhas com deadline em [hoje, hoje + deadline_alert_days_before]
 *     - SKIP se 0 items pendentes (operador já aprovou/rejeitou tudo)
 *     - Severity escala: D-2+ medium / D-1 high / D-0 critical
 *     - Dedup: 1 alerta por (campaign × dia × severity)
 *     - Agrupamento (M3 — implementado quando 5+ campanhas pro mesmo operador)
 *
 *  2. SUBSIDY OPPORTUNITY (proativo):
 *     - Campanhas novas (started_at recente OU has_subsidy_items + nao
 *       alertada antes) com avg_meli_subsidy_pct > config threshold
 *     - 1× lifetime por (campaign × type)
 *
 *  3. MANAGER QUEUE DIGEST:
 *     - Se gestor tem N+ pending_manager_approval na fila E não recebeu
 *       digest hoje → manda WhatsApp pro manager_whatsapp_phone
 *
 *  Tudo registra em ml_campaign_alert_log (audit + dedup + grouping).
 */

import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { ActiveBridgeClient } from '../active-bridge/active-bridge.client'

interface ConfigRow {
  id:                                string
  organization_id:                   string
  seller_id:                         number
  whatsapp_alerts_enabled:           boolean
  deadline_alert_days_before:        number
  escalate_alerts:                   boolean
  auto_alert_when_subsidy_above_pct: number | null
  audit_attempts_threshold:          number
  assignee_user_id:                  string | null
  notification_phone:                string | null
  manager_user_id:                   string | null
  manager_whatsapp_phone:            string | null
  // M4 — Active integration
  active_org_id:                     string | null   // SaaS↔Active UUID mapping
  active_pipeline_id:                string | null
  active_stage_initial_id:           string | null
  active_stage_pending_manager_id:   string | null
  active_stage_in_campaign_id:       string | null
  active_assigned_to:                string | null
}

interface CampaignRow {
  id:                       string
  organization_id:          string
  seller_id:                number
  ml_campaign_id:           string
  ml_promotion_type:        string
  name:                     string | null
  deadline_date:            string | null
  finish_date:              string | null
  candidate_count:          number
  pending_count:            number
  started_count:            number
  has_subsidy_items:        boolean
  avg_meli_subsidy_pct:     number | null
}

@Injectable()
export class MlCampaignsAlertsService {
  private readonly logger = new Logger(MlCampaignsAlertsService.name)

  constructor(private readonly bridge: ActiveBridgeClient) {}

  // ── Cron: 9h diário SP — alertas do dia ────────────────────────

  @Cron('0 9 * * *', { name: 'ml-campaigns-alerts', timeZone: 'America/Sao_Paulo' })
  async dailyAlerts(): Promise<void> {
    if (process.env.DISABLE_ML_CAMPAIGNS_WORKER === 'true') return

    this.logger.log('[alerts] iniciando varredura diária')

    // Busca todas as configs com whatsapp habilitado
    const { data: configs, error } = await supabaseAdmin
      .from('ml_campaigns_config')
      .select('id, organization_id, seller_id, whatsapp_alerts_enabled, deadline_alert_days_before, escalate_alerts, auto_alert_when_subsidy_above_pct, audit_attempts_threshold, assignee_user_id, notification_phone, manager_user_id, manager_whatsapp_phone, active_org_id, active_pipeline_id, active_stage_initial_id, active_stage_pending_manager_id, active_stage_in_campaign_id, active_assigned_to')
      .eq('whatsapp_alerts_enabled', true)

    if (error || !configs) {
      this.logger.error(`[alerts] falha ao listar configs: ${error?.message}`)
      return
    }

    let totalSent = 0, totalSkipped = 0
    for (const c of configs as ConfigRow[]) {
      try {
        const result = await this.processOrgSeller(c)
        totalSent    += result.sent
        totalSkipped += result.skipped
      } catch (e) {
        this.logger.error(`[alerts] org=${c.organization_id} seller=${c.seller_id} falhou: ${(e as Error).message}`)
      }
    }

    // M3 — Pós-processamento: se mesmo destinatário (phone) recebeu 5+
    // alertas hoje, manda 1 digest "Você tem N pendências hoje" e marca
    // os outros como skipped. Acontece DEPOIS do envio normal pra que
    // dedup logs já estejam gravados.
    await this.collapseGroupedAlerts()

    this.logger.log(`[alerts] varredura concluída — enviados=${totalSent} skipped=${totalSkipped}`)
  }

  /** M3 — Detecta operadores com 5+ alertas hoje e manda digest agrupado.
   *  Threshold fixo em 5 (poderia virar config no futuro). Só considera
   *  alertas SENT (não logs de skip).
   *
   *  Importante: o agrupamento NÃO desfaz envios já feitos; ele apenas
   *  evita NOVOS alertas no resto do dia mandando 1 digest de fechamento.
   *  Isso é checado em wasGroupingActive() antes de cada envio futuro. */
  private async collapseGroupedAlerts(): Promise<void> {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
    const { data: today } = await supabaseAdmin
      .from('ml_campaign_alert_log')
      .select('organization_id, seller_id, recipient_phone, recipient_user_id, alert_type')
      .eq('status', 'sent')
      .gte('created_at', todayStart.toISOString())

    if (!today || today.length === 0) return

    // Agrupa por (org × phone)
    const groups = new Map<string, { orgId: string; phone: string; userId: string | null; sellerId: number; count: number }>()
    for (const a of today as Array<{ organization_id: string; seller_id: number; recipient_phone: string | null; recipient_user_id: string | null; alert_type: string }>) {
      if (!a.recipient_phone) continue
      const key = `${a.organization_id}|${a.recipient_phone}`
      const cur = groups.get(key)
      if (cur) cur.count++
      else groups.set(key, { orgId: a.organization_id, phone: a.recipient_phone, userId: a.recipient_user_id, sellerId: a.seller_id, count: 1 })
    }

    const GROUPING_THRESHOLD = 5
    for (const g of groups.values()) {
      if (g.count < GROUPING_THRESHOLD) continue

      const dedupKey = `digest:${g.orgId}:${g.phone}:${todayStart.toISOString().slice(0, 10)}`
      if (await this.wasAlreadySent(g.orgId, dedupKey)) continue

      const message = (
        `📊 Resumo do dia — você tem ${g.count} pendências de campanha pra revisar.\n\n` +
        `Pra evitar spam, próximas atualizações vão chegar amanhã. Acesse o painel pra detalhes.`
      )
      const deeplink = '/dashboard/ml-campaigns'

      try {
        const bridgeResp = await this.bridge.notifyLojista({
          organization_id: g.orgId,
          message,
          severity:        'medium',
          deeplink,
        })
        await supabaseAdmin
          .from('ml_campaign_alert_log')
          .insert({
            organization_id:   g.orgId,
            seller_id:         g.sellerId,
            campaign_id:       null,
            alert_type:        'manager_pending_queue', // reutiliza tipo (digest é manager_pending_queue genérico)
            severity:          'medium',
            recipient_user_id: g.userId,
            recipient_phone:   g.phone,
            message,
            deeplink,
            bridge_response:   bridgeResp,
            status:            'sent',
            dedup_key:         dedupKey,
          })
        this.logger.log(`[alerts] digest enviado pra ${g.phone} (${g.count} alertas hoje)`)
      } catch (e) {
        this.logger.warn(`[alerts] digest falhou ${g.phone}: ${(e as Error).message}`)
      }
    }
  }

  /** Checa se o phone já recebeu o digest de fechamento hoje.
   *  Se sim, próximos alertas devem ser pulados pra não duplicar. */
  private async digestAlreadySentToday(orgId: string, phone: string): Promise<boolean> {
    const today = new Date().toISOString().slice(0, 10)
    const dedupKey = `digest:${orgId}:${phone}:${today}`
    return this.wasAlreadySent(orgId, dedupKey)
  }

  /** Endpoint manual pro user disparar a varredura sem aguardar 9h. */
  async runNow(orgId: string, sellerId?: number): Promise<{ sent: number; skipped: number }> {
    let q = supabaseAdmin
      .from('ml_campaigns_config')
      .select('id, organization_id, seller_id, whatsapp_alerts_enabled, deadline_alert_days_before, escalate_alerts, auto_alert_when_subsidy_above_pct, audit_attempts_threshold, assignee_user_id, notification_phone, manager_user_id, manager_whatsapp_phone, active_org_id, active_pipeline_id, active_stage_initial_id, active_stage_pending_manager_id, active_stage_in_campaign_id, active_assigned_to')
      .eq('organization_id', orgId)
      .eq('whatsapp_alerts_enabled', true)
    if (sellerId != null) q = q.eq('seller_id', sellerId)

    const { data: configs } = await q
    if (!configs || configs.length === 0) return { sent: 0, skipped: 0 }

    let sent = 0, skipped = 0
    for (const c of configs as ConfigRow[]) {
      const r = await this.processOrgSeller(c)
      sent += r.sent; skipped += r.skipped
    }
    return { sent, skipped }
  }

  /** Processa 1 seller — chama os 3 tipos de alerta. */
  private async processOrgSeller(cfg: ConfigRow): Promise<{ sent: number; skipped: number }> {
    let sent = 0, skipped = 0

    // 1. Deadline warnings (escala)
    const dl = await this.processDeadlineWarnings(cfg)
    sent += dl.sent; skipped += dl.skipped

    // 2. Subsidy opportunities
    if ((cfg.auto_alert_when_subsidy_above_pct ?? 0) > 0) {
      const sub = await this.processSubsidyOpportunities(cfg)
      sent += sub.sent; skipped += sub.skipped
    }

    // 3. Manager queue digest
    if (cfg.manager_whatsapp_phone) {
      const mq = await this.processManagerQueueDigest(cfg)
      sent += mq.sent; skipped += mq.skipped
    }

    return { sent, skipped }
  }

  // ──────────────────────────────────────────────────────────────────
  // 1. DEADLINE WARNING
  // ──────────────────────────────────────────────────────────────────

  private async processDeadlineWarnings(cfg: ConfigRow): Promise<{ sent: number; skipped: number }> {
    if (!cfg.notification_phone) {
      return { sent: 0, skipped: 0 }
    }

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const horizon = new Date(today)
    horizon.setDate(today.getDate() + cfg.deadline_alert_days_before)
    horizon.setHours(23, 59, 59, 999)

    // Campanhas com deadline na janela
    const { data: campaigns } = await supabaseAdmin
      .from('ml_campaigns')
      .select('id, organization_id, seller_id, ml_campaign_id, ml_promotion_type, name, deadline_date, finish_date, candidate_count, pending_count, started_count, has_subsidy_items, avg_meli_subsidy_pct')
      .eq('organization_id', cfg.organization_id)
      .eq('seller_id',       cfg.seller_id)
      .gte('deadline_date',  today.toISOString())
      .lte('deadline_date',  horizon.toISOString())

    if (!campaigns || campaigns.length === 0) return { sent: 0, skipped: 0 }

    let sent = 0, skipped = 0
    for (const c of campaigns as CampaignRow[]) {
      const result = await this.sendDeadlineAlert(cfg, c)
      if (result === 'sent') sent++
      else                   skipped++
    }
    return { sent, skipped }
  }

  private async sendDeadlineAlert(cfg: ConfigRow, c: CampaignRow): Promise<'sent' | 'skipped'> {
    if (!c.deadline_date) return 'skipped'

    // Calcula dias até deadline
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const dl = new Date(c.deadline_date); dl.setHours(0, 0, 0, 0)
    const daysLeft = Math.round((dl.getTime() - today.getTime()) / (24 * 3600 * 1000))

    // Severity escala (ou flat se config desabilitar escalate)
    let severity: 'low' | 'medium' | 'high' | 'critical' = 'medium'
    if (cfg.escalate_alerts) {
      if (daysLeft <= 0)      severity = 'critical'
      else if (daysLeft === 1) severity = 'high'
      else                     severity = 'medium'
    } else {
      severity = 'high'   // sem escala, manda 1 nivel só
    }

    // Conta items pendentes (sem ação do operador)
    const { count: pendingItems } = await supabaseAdmin
      .from('ml_campaign_recommendations')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', cfg.organization_id)
      .eq('campaign_id',     c.id)
      .eq('status', 'pending')

    const pending = pendingItems ?? 0

    // Se 0 pendentes, operador já agiu (mesmo se não aprovou tudo, pelo menos
    // fez triagem) — não alertar
    if (pending === 0 && c.candidate_count > 0) {
      // Mas se nem geração de IA rolou, tem candidate_count > 0 sem reco — alerta!
      // ESSA é uma situação relevante: operador esqueceu de gerar IA
    } else if (pending === 0) {
      // Skip — sem nada pra fazer
      await this.logSkipped(cfg, c.id, 'deadline_warning', severity, 'no_pending_items',
        this.deadlineDedupKey(c.id, severity))
      return 'skipped'
    }

    const dedupKey = this.deadlineDedupKey(c.id, severity)

    // Já enviou esse alerta hoje?
    if (await this.wasAlreadySent(cfg.organization_id, dedupKey)) {
      return 'skipped'
    }

    const dayLabel = daysLeft <= 0 ? 'ENCERRA HOJE' : `D-${daysLeft}`
    const campaignName = c.name ?? c.ml_promotion_type
    const subsidyHint  = c.has_subsidy_items
      ? ` 💰 ML subsidia ~${c.avg_meli_subsidy_pct?.toFixed(1) ?? '?'}%.`
      : ''
    const message = (
      `⚠️ ${dayLabel} — Campanha "${campaignName}" encerra em ${daysLeft <= 0 ? 'horas' : `${daysLeft} dia${daysLeft === 1 ? '' : 's'}`}. ` +
      `Você tem ${pending} item${pending === 1 ? '' : 's'} candidato${pending === 1 ? '' : 's'} sem decisão.${subsidyHint}\n\n` +
      `Acesse e decida agora.`
    )
    const deeplink = `/dashboard/ml-campaigns/${c.id}`

    const result = await this.dispatch(cfg, c, 'deadline_warning', severity, message, deeplink, dedupKey)

    // M4 — se Active configurado, cria card no funil "Campanhas/Promoção"
    // + task vinculada. Idempotente via dedup_key (mesmo deal pra mesmo
    // contexto não duplica). Falha graciosa: erro NÃO impede WhatsApp.
    if (result === 'sent') {
      void this.tryCreateActiveCard(cfg, c, severity, daysLeft, pending).catch(e =>
        this.logger.warn(`[alerts] active card falhou pra ${c.id}: ${(e as Error).message}`),
      )
    }

    return result
  }

  /** Cria card no funil + task no Active. No-op se config M4 ausente. */
  private async tryCreateActiveCard(
    cfg: ConfigRow,
    c: CampaignRow,
    severity: 'low' | 'medium' | 'high' | 'critical',
    daysLeft: number,
    pending: number,
  ): Promise<void> {
    if (!cfg.active_pipeline_id || !cfg.active_stage_initial_id || !cfg.active_assigned_to) {
      return // M4 não configurado pra essa org/seller
    }

    const dayLabel = daysLeft <= 0 ? 'HOJE' : `D-${daysLeft}`
    const cardTitle = `${c.ml_promotion_type} — ${c.name ?? c.ml_campaign_id} (${dayLabel})`
    const taskTitle = `Revisar ${pending} candidato${pending === 1 ? '' : 's'} de "${c.name ?? c.ml_promotion_type}" antes do deadline`

    // Dedup: 1 card por campanha (não 1 por dia × severity — gestor não
    // quer ver o mesmo deal sendo recriado a cada escalada)
    const dedupKey = `campaign:${c.id}`

    // Usa active_org_id se preenchido (mapeamento SaaS↔Active), senão usa
    // o próprio organization_id (compat com setups single-DB)
    const activeOrgId = cfg.active_org_id ?? cfg.organization_id

    await this.bridge.createCampaignCard({
      organization_id: activeOrgId,
      pipeline_id:     cfg.active_pipeline_id,
      stage_id:        cfg.active_stage_initial_id,
      assigned_to:     cfg.active_assigned_to,
      title:           cardTitle,
      task_title:      taskTitle,
      due_date:        c.deadline_date ?? undefined,
      tags:            ['campaign-center', c.ml_promotion_type.toLowerCase(), `deadline-${dayLabel.toLowerCase()}`],
      metadata: {
        ml_campaign_id:    c.ml_campaign_id,
        ml_promotion_type: c.ml_promotion_type,
        seller_id:         c.seller_id,
        candidate_count:   c.candidate_count,
        pending_items:     pending,
        severity,
        days_left:         daysLeft,
        has_subsidy:       c.has_subsidy_items,
        avg_subsidy_pct:   c.avg_meli_subsidy_pct,
      },
      dedup_key:       dedupKey,
    })
  }

  private deadlineDedupKey(campaignId: string, severity: string): string {
    const today = new Date().toISOString().slice(0, 10)
    return `deadline_warning:${campaignId}:${today}:${severity}`
  }

  // ──────────────────────────────────────────────────────────────────
  // 2. SUBSIDY OPPORTUNITY (proativo)
  // ──────────────────────────────────────────────────────────────────

  private async processSubsidyOpportunities(cfg: ConfigRow): Promise<{ sent: number; skipped: number }> {
    if (!cfg.notification_phone) return { sent: 0, skipped: 0 }
    const threshold = Number(cfg.auto_alert_when_subsidy_above_pct ?? 0)
    if (threshold <= 0) return { sent: 0, skipped: 0 }

    // Campanhas vivas (started_count > 0 OR pending_count > 0) com subsídio alto
    const { data: campaigns } = await supabaseAdmin
      .from('ml_campaigns')
      .select('id, organization_id, seller_id, ml_campaign_id, ml_promotion_type, name, deadline_date, finish_date, candidate_count, pending_count, started_count, has_subsidy_items, avg_meli_subsidy_pct')
      .eq('organization_id', cfg.organization_id)
      .eq('seller_id',       cfg.seller_id)
      .eq('has_subsidy_items', true)
      .gte('avg_meli_subsidy_pct', threshold)
      .gt('candidate_count', 0)
      .in('status', ['started', 'pending'])

    if (!campaigns || campaigns.length === 0) return { sent: 0, skipped: 0 }

    let sent = 0, skipped = 0
    for (const c of campaigns as CampaignRow[]) {
      const dedupKey = `subsidy_opportunity:${c.id}` // 1× lifetime
      if (await this.wasAlreadySent(cfg.organization_id, dedupKey)) {
        skipped++
        continue
      }
      const message = (
        `🎯 Oportunidade rara — ML subsidia ${c.avg_meli_subsidy_pct?.toFixed(1)}% na campanha "${c.name ?? c.ml_promotion_type}". ` +
        `${c.candidate_count} produto${c.candidate_count === 1 ? '' : 's'} elegível${c.candidate_count === 1 ? '' : 'eis'}. ` +
        `Vale revisar pra aproveitar.`
      )
      const deeplink = `/dashboard/ml-campaigns/${c.id}`
      const r = await this.dispatch(cfg, c, 'subsidy_opportunity', 'opportunity' as 'medium', message, deeplink, dedupKey)
      if (r === 'sent') sent++; else skipped++
    }
    return { sent, skipped }
  }

  // ──────────────────────────────────────────────────────────────────
  // 3. MANAGER QUEUE DIGEST
  // ──────────────────────────────────────────────────────────────────

  private async processManagerQueueDigest(cfg: ConfigRow): Promise<{ sent: number; skipped: number }> {
    if (!cfg.manager_whatsapp_phone) return { sent: 0, skipped: 0 }

    const { count: pendingCount } = await supabaseAdmin
      .from('ml_campaign_recommendations')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', cfg.organization_id)
      .eq('seller_id',       cfg.seller_id)
      .eq('status', 'pending_manager_approval')

    const pending = pendingCount ?? 0
    if (pending === 0) return { sent: 0, skipped: 1 }

    const today = new Date().toISOString().slice(0, 10)
    const dedupKey = `manager_pending_queue:${cfg.id}:${today}`
    if (await this.wasAlreadySent(cfg.organization_id, dedupKey)) {
      return { sent: 0, skipped: 1 }
    }

    // Verifica se passou do audit_attempts_threshold (operador suspeito?)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
    const { data: recentAttempts } = await supabaseAdmin
      .from('ml_campaign_approval_attempts')
      .select('operator_user_id')
      .eq('organization_id', cfg.organization_id)
      .gte('created_at',     thirtyDaysAgo)

    const counts = new Map<string, number>()
    for (const a of (recentAttempts as Array<{ operator_user_id: string }>) ?? []) {
      counts.set(a.operator_user_id, (counts.get(a.operator_user_id) ?? 0) + 1)
    }
    const suspicious = [...counts.entries()].filter(([_, c]) => c >= cfg.audit_attempts_threshold)
    const suspiciousNote = suspicious.length > 0
      ? `\n⚠️ ${suspicious.length} operador${suspicious.length === 1 ? '' : 'es'} acumulou ${suspicious[0][1]}+ tentativas abaixo do gate em 30d.`
      : ''

    const message = (
      `📋 Fila do gestor: ${pending} recomendação${pending === 1 ? '' : 'ões'} aguardando sua decisão de override de margem.${suspiciousNote}\n\n` +
      `Revise e libere/rejeite.`
    )
    const deeplink = '/dashboard/ml-campaigns/manager-queue'

    // Envia pro manager_whatsapp_phone (não usa notification_phone)
    return this.dispatchToPhone(
      cfg,
      null,                       // sem campaign específica
      'manager_pending_queue',
      'high',
      message,
      deeplink,
      dedupKey,
      cfg.manager_user_id ?? null,
      cfg.manager_whatsapp_phone,
    ).then(r => ({ sent: r === 'sent' ? 1 : 0, skipped: r === 'sent' ? 0 : 1 }))
  }

  // ──────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────

  private async dispatch(
    cfg: ConfigRow,
    c: CampaignRow,
    alertType: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    message: string,
    deeplink: string,
    dedupKey: string,
  ): Promise<'sent' | 'skipped'> {
    return this.dispatchToPhone(
      cfg,
      c.id,
      alertType,
      severity,
      message,
      deeplink,
      dedupKey,
      cfg.assignee_user_id,
      cfg.notification_phone,
    )
  }

  private async dispatchToPhone(
    cfg: ConfigRow,
    campaignId: string | null,
    alertType: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    message: string,
    deeplink: string,
    dedupKey: string,
    recipientUserId: string | null,
    recipientPhone: string | null,
  ): Promise<'sent' | 'skipped'> {
    if (!recipientPhone) return 'skipped'

    // M3: se digest de fechamento já foi mandado hoje, pula novos alertas
    // pra esse phone (até amanhã)
    if (await this.digestAlreadySentToday(cfg.organization_id, recipientPhone)) {
      await supabaseAdmin
        .from('ml_campaign_alert_log')
        .insert({
          organization_id:   cfg.organization_id,
          seller_id:         cfg.seller_id,
          campaign_id:       campaignId,
          alert_type:        alertType,
          severity,
          recipient_user_id: recipientUserId,
          recipient_phone:   recipientPhone,
          message,
          deeplink,
          status:            'skipped_dedup',
          skip_reason:       'digest_sent_today',
          dedup_key:         dedupKey,
        })
      return 'skipped'
    }

    let bridgeResp: unknown = null
    let status: 'sent' | 'failed' = 'sent'
    try {
      // Map severity 'opportunity' não existe no notifyLojista — re-mapeia.
      const bridgeSeverity = severity === 'critical'  ? 'critical'
                          : severity === 'high'      ? 'high'
                          : severity === 'low'       ? 'low'
                          : 'medium'
      bridgeResp = await this.bridge.notifyLojista({
        organization_id: cfg.organization_id,
        message,
        severity:        bridgeSeverity,
        deeplink,
      })
    } catch (e) {
      status = 'failed'
      bridgeResp = { error: (e as Error).message }
      this.logger.warn(`[alerts] dispatch falhou ${alertType} ${dedupKey}: ${(e as Error).message}`)
    }

    // Insere no log (mesmo se falhou — pra rastreio)
    await supabaseAdmin
      .from('ml_campaign_alert_log')
      .insert({
        organization_id:   cfg.organization_id,
        seller_id:         cfg.seller_id,
        campaign_id:       campaignId,
        alert_type:        alertType,
        severity,
        recipient_user_id: recipientUserId,
        recipient_phone:   recipientPhone,
        message,
        deeplink,
        bridge_response:   bridgeResp,
        status,
        dedup_key:         dedupKey,
      })
      .select('id')
      .maybeSingle()

    return status === 'sent' ? 'sent' : 'skipped'
  }

  private async logSkipped(
    cfg: ConfigRow,
    campaignId: string,
    alertType: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    skipReason: string,
    dedupKey: string,
  ): Promise<void> {
    await supabaseAdmin
      .from('ml_campaign_alert_log')
      .insert({
        organization_id: cfg.organization_id,
        seller_id:       cfg.seller_id,
        campaign_id:     campaignId,
        alert_type:      alertType,
        severity,
        message:         '(skipped)',
        status:          'skipped_no_action',
        skip_reason:     skipReason,
        dedup_key:       dedupKey,
      })
  }

  private async wasAlreadySent(orgId: string, dedupKey: string): Promise<boolean> {
    const { data } = await supabaseAdmin
      .from('ml_campaign_alert_log')
      .select('id')
      .eq('organization_id', orgId)
      .eq('dedup_key',       dedupKey)
      .eq('status',          'sent')
      .limit(1)
      .maybeSingle()
    return Boolean(data)
  }
}
