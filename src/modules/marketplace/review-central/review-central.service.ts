import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { ShopeeReviewsService } from '../shopee-reviews/shopee-reviews.service'
import { ActiveBridgeClient } from '../../active-bridge/active-bridge.client'
import { UnifiedWhatsAppSender } from '../../wa-router/unified-whatsapp-sender.service'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

export interface ReviewCentralConfig {
  organization_id:        string
  autopilot_enabled:      boolean
  auto_reply_min_rating:  number
  auto_reply_window_days: number
  max_auto_per_hour:      number
  sensitive_words:        string[]
  notification_phone:     string | null
  active_org_id:          string | null
  active_pipeline_id:     string | null
  active_stage_id:        string | null
}

/** Central de Avaliações — AUTOMAÇÃO (piloto automático, opt-in por org).
 *
 *  Regra de negócio (decisão do user 2026-06-12):
 *  - POSITIVA (≥ min_rating, sem palavra sensível, plataforma permite
 *    resposta): IA gera e PUBLICA sozinha (cap por hora).
 *  - NEGATIVA (≤3★) OU palavra sensível (qualquer nota): NÃO responde —
 *    alerta o operador no WhatsApp + cria CARD num funil do Active (o
 *    operador precisa entrar e tratar).
 *  - Neutra (entre min_rating e 4★ sem sensível): marca skipped (fica na
 *    tela pra resposta manual).
 *
 *  Gate global REVIEW_AUTOPILOT='on' + flag por org (review_central_config). */
@Injectable()
export class ReviewCentralService {
  private readonly logger = new Logger(ReviewCentralService.name)
  private static readonly BATCH = 40
  private static readonly PIPELINE_NAME = 'Central de Avaliações'
  private static readonly PIPELINE_STAGES = ['📍 Responder', '🛠️ Em tratamento', '✅ Concluído']

  constructor(
    private readonly shopeeReviews: ShopeeReviewsService,
    private readonly bridge:        ActiveBridgeClient,
    private readonly wa:            UnifiedWhatsAppSender,
  ) {}

  @Cron('*/10 * * * *', { name: 'review-central-autopilot' })
  async tick(): Promise<void> {
    if (process.env.REVIEW_AUTOPILOT !== 'on') return
    const { data: configs } = await supabaseAdmin
      .from('review_central_config')
      .select('*')
      .eq('autopilot_enabled', true)
    for (const cfg of (configs ?? []) as ReviewCentralConfig[]) {
      try {
        await this.processOrg(cfg)
      } catch (e) {
        this.logger.warn(`[review-central] org=${cfg.organization_id}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  /** Processa avaliações ainda não vistas pela automação (mais recentes
   *  primeiro, janela configurável). Exposto pro POST manual da tela. */
  async processOrg(cfg: ReviewCentralConfig): Promise<{ processed: number; auto_replied: number; tasks: number }> {
    const windowStart = new Date(Date.now() - cfg.auto_reply_window_days * 86400_000).toISOString()
    const { data: pending } = await supabaseAdmin
      .from('marketplace_reviews')
      .select('*')
      .eq('organization_id', cfg.organization_id)
      .is('automation_processed_at', null)
      .gte('review_create_at', windowStart)
      .order('review_create_at', { ascending: false })
      .limit(ReviewCentralService.BATCH)

    let autoReplied = 0
    let tasks = 0
    for (const review of (pending ?? []) as Json[]) {
      try {
        const r = await this.processReview(cfg, review)
        if (r === 'auto_replied')  autoReplied++
        if (r === 'task_created') tasks++
      } catch (e: unknown) {
        await this.markProcessed(review.id, 'error', { last: (e as Error)?.message?.slice(0, 200) })
        this.logger.warn(`[review-central] review=${review.id}: ${(e as Error)?.message}`)
      }
    }
    if ((pending?.length ?? 0) > 0) {
      this.logger.log(`[review-central] org=${cfg.organization_id} processadas=${pending?.length} auto=${autoReplied} tarefas=${tasks}`)
    }
    return { processed: pending?.length ?? 0, auto_replied: autoReplied, tasks }
  }

  private async processReview(cfg: ReviewCentralConfig, review: Json): Promise<string> {
    const rating = Number(review.rating) || 0
    const text = String(review.comment ?? '').toLowerCase()
    const sensitiveHits = (cfg.sensitive_words ?? []).filter(w => w && text.includes(w.toLowerCase()))
    const isNegative = rating > 0 && rating <= 3
    const needsHuman = isNegative || sensitiveHits.length > 0

    // ── Negativa/sensível → operador (WhatsApp + card no Active) ────────────
    if (needsHuman) {
      // já tem resposta publicada? só registra (nada a tratar)
      if (review.reply_text) return await this.markProcessed(review.id, 'skipped_already_replied', { sensitiveHits })
      const dealId = await this.createActiveTask(cfg, review, sensitiveHits)
      await this.alertOperator(cfg, review, sensitiveHits)
      return await this.markProcessed(review.id, 'task_created', { sensitiveHits, dealId })
    }

    // ── Positiva → auto-resposta (só plataformas que permitem) ──────────────
    const canReply = review.platform === 'shopee'
      && !review.reply_text
      && review.editable === 'EDITABLE'
    if (rating >= cfg.auto_reply_min_rating && canReply) {
      // trava por hora
      const oneHourAgo = new Date(Date.now() - 3600_000).toISOString()
      const { count } = await supabaseAdmin
        .from('marketplace_reviews')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', cfg.organization_id)
        .eq('automation_status', 'auto_replied')
        .gte('automation_processed_at', oneHourAgo)
      if ((count ?? 0) >= cfg.max_auto_per_hour) {
        return 'deferred' // NÃO marca processada — tenta no próximo tick
      }

      const { text: suggestion } = await this.shopeeReviews.suggest(cfg.organization_id, review.id)
      await this.shopeeReviews.reply(cfg.organization_id, review.id, suggestion)
      this.logger.log(`[review-central] auto-resposta publicada review=${review.external_review_id} (${rating}★)`)
      return await this.markProcessed(review.id, 'auto_replied', {})
    }

    // ── Neutra / sem como responder → fica pra ação manual na tela ──────────
    const reason = review.reply_text ? 'skipped_already_replied'
      : review.platform !== 'shopee'  ? 'skipped_no_reply_api'
      : review.editable !== 'EDITABLE' ? 'skipped_expired'
      : 'skipped_neutral'
    return await this.markProcessed(review.id, reason, {})
  }

  private async markProcessed(reviewId: string, status: string, extra: { sensitiveHits?: string[]; dealId?: string | null; last?: string }): Promise<string> {
    await supabaseAdmin
      .from('marketplace_reviews')
      .update({
        automation_status:       status,
        automation_processed_at: new Date().toISOString(),
        sensitive_terms:         extra.sensitiveHits?.length ? extra.sensitiveHits : null,
        active_deal_id:          extra.dealId ?? undefined,
        updated_at:              new Date().toISOString(),
      })
      .eq('id', reviewId)
    return status
  }

  // ── Negativa: card no funil do Active ─────────────────────────────────────

  private async createActiveTask(cfg: ReviewCentralConfig, review: Json, sensitiveHits: string[]): Promise<string | null> {
    const activeOrgId = cfg.active_org_id ?? cfg.organization_id

    // garante o funil 1x e cacheia na config
    let pipelineId = cfg.active_pipeline_id
    let stageId = cfg.active_stage_id
    if (!pipelineId || !stageId) {
      const funnel = await this.bridge.ensureServicePipeline({
        organization_id: activeOrgId,
        name:            ReviewCentralService.PIPELINE_NAME,
        stages:          ReviewCentralService.PIPELINE_STAGES,
      })
      if (!funnel.pipeline_id || !funnel.default_stage_id) {
        this.logger.warn('[review-central] Active bridge indisponível — card não criado')
        return null
      }
      pipelineId = funnel.pipeline_id
      stageId = funnel.default_stage_id
      await supabaseAdmin
        .from('review_central_config')
        .update({ active_pipeline_id: pipelineId, active_stage_id: stageId, updated_at: new Date().toISOString() })
        .eq('organization_id', cfg.organization_id)
      cfg.active_pipeline_id = pipelineId
      cfg.active_stage_id = stageId
    }

    const platformLabel = review.platform === 'mercadolivre' ? 'Mercado Livre' : review.platform === 'shopee' ? 'Shopee' : review.platform
    const stars = '★'.repeat(Number(review.rating) || 0) || '?'
    const sensiveNote = sensitiveHits.length ? ` ⚠️ ${sensitiveHits.join(', ')}` : ''
    const result = await this.bridge.createCampaignCard({
      organization_id: activeOrgId,
      pipeline_id:     pipelineId,
      stage_id:        stageId,
      title:           `${stars} ${platformLabel} — ${review.buyer_username ?? 'comprador'}${sensiveNote}`,
      task_title:      `Tratar avaliação ${review.rating}★ (${platformLabel})`,
      tags:            ['avaliacao', review.platform, ...(sensitiveHits.length ? ['sensivel'] : ['negativa'])],
      metadata: {
        review_id:    review.id,
        platform:     review.platform,
        rating:       review.rating,
        comment:      String(review.comment ?? '').slice(0, 500),
        item_id:      review.item_id,
        order_sn:     review.order_sn,
        sensitive:    sensitiveHits,
        review_date:  review.review_create_at,
        can_reply:    review.platform === 'shopee' && review.editable === 'EDITABLE',
      },
      dedup_key: `review:${review.id}`,
    })
    return result.deal_id ?? null
  }

  // ── Negativa: WhatsApp pro operador ──────────────────────────────────────

  private async alertOperator(cfg: ReviewCentralConfig, review: Json, sensitiveHits: string[]): Promise<void> {
    if (!cfg.notification_phone) return
    const platformLabel = review.platform === 'mercadolivre' ? 'Mercado Livre' : review.platform === 'shopee' ? 'Shopee' : review.platform
    const motivo = sensitiveHits.length
      ? `⚠️ palavra sensível: ${sensitiveHits.join(', ')}`
      : `nota baixa (${review.rating}★)`
    const msg =
      `🚨 *Avaliação precisa de atenção* — ${platformLabel}\n\n` +
      `${'★'.repeat(Number(review.rating) || 0)} (${review.rating}/5) · ${review.buyer_username ?? 'comprador'}\n` +
      `Motivo: ${motivo}\n\n` +
      `"${String(review.comment ?? '(sem texto)').slice(0, 200)}"\n\n` +
      `📋 Card criado no funil "${ReviewCentralService.PIPELINE_NAME}" do Active — entre lá pra tratar.\n` +
      `🔗 eclick.app.br/dashboard/atendimento/avaliacoes`

    try {
      const r = await this.wa.send(cfg.organization_id, 'internal_alert', cfg.notification_phone, msg)
      if (r.success) return
      this.logger.warn(`[review-central] alerta WA (router) falhou: ${r.error}`)
    } catch (e: unknown) {
      this.logger.warn(`[review-central] alerta WA (router) erro: ${(e as Error)?.message}`)
    }
    // fallback: via Active (send-direct)
    try {
      await this.bridge.sendDirectMessage({
        organization_id: cfg.active_org_id ?? cfg.organization_id,
        phone:           cfg.notification_phone,
        message:         msg,
        dedup_key:       `review-alert:${review.id}`,
      })
    } catch (e: unknown) {
      this.logger.warn(`[review-central] alerta WA (bridge) erro: ${(e as Error)?.message}`)
    }
  }

  // ── Config (tela) ─────────────────────────────────────────────────────────

  async getConfig(orgId: string): Promise<ReviewCentralConfig> {
    const { data } = await supabaseAdmin
      .from('review_central_config')
      .select('*')
      .eq('organization_id', orgId)
      .maybeSingle()
    if (data) return data as ReviewCentralConfig
    // default (não persiste até o user salvar)
    return {
      organization_id: orgId,
      autopilot_enabled: false,
      auto_reply_min_rating: 5,
      auto_reply_window_days: 30,
      max_auto_per_hour: 20,
      sensitive_words: [
        'procon', 'processo', 'justiça', 'advogado', 'golpe', 'fraude', 'falsificado',
        'polícia', 'denúncia', 'perigoso', 'incêndio', 'choque', 'machucou', 'acidente', 'reclame aqui',
      ],
      notification_phone: null,
      active_org_id: null,
      active_pipeline_id: null,
      active_stage_id: null,
    }
  }

  async saveConfig(orgId: string, input: Partial<ReviewCentralConfig>): Promise<ReviewCentralConfig> {
    const minRating = Number(input.auto_reply_min_rating ?? 5)
    if (minRating < 4 || minRating > 5) throw new BadRequestException('auto_reply_min_rating deve ser 4 ou 5')
    const row = {
      organization_id:        orgId,
      autopilot_enabled:      Boolean(input.autopilot_enabled),
      auto_reply_min_rating:  minRating,
      auto_reply_window_days: Math.min(Math.max(Number(input.auto_reply_window_days ?? 30), 1), 90),
      max_auto_per_hour:      Math.min(Math.max(Number(input.max_auto_per_hour ?? 20), 1), 100),
      sensitive_words:        Array.isArray(input.sensitive_words)
        ? input.sensitive_words.map(w => String(w).trim().toLowerCase()).filter(Boolean)
        : undefined,
      notification_phone:     input.notification_phone?.toString().trim() || null,
      updated_at:             new Date().toISOString(),
    }
    const { data, error } = await supabaseAdmin
      .from('review_central_config')
      .upsert(row, { onConflict: 'organization_id' })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`Falha ao salvar config: ${error.message}`)
    return data as ReviewCentralConfig
  }

  /** Roda a automação agora pra org (botão da tela / smoke). */
  async runNow(orgId: string): Promise<Json> {
    const cfg = await this.getConfig(orgId)
    if (!cfg.autopilot_enabled) throw new BadRequestException('Piloto automático desligado — ligue na configuração da Central')
    return this.processOrg(cfg)
  }
}
