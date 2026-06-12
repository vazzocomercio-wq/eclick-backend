import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { ActiveBridgeClient } from '../../active-bridge/active-bridge.client'
import { ReviewCentralService } from '../review-central/review-central.service'
import { UnifiedWhatsAppSender } from '../../wa-router/unified-whatsapp-sender.service'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

interface SacConfig {
  organization_id: string
  active_org_id:   string | null
  pipeline_id:     string | null
  stages:          Array<{ id: string; name: string }> | null
}

/** Devolução → ticket no CRM (SAC).
 *
 *  Toda devolução de marketplace com status ABERTO vira um card no funil
 *  "SAC — Devoluções" do Active (dedup `return:{id}`), e o card avança
 *  sozinho quando o sync de devoluções detecta mudança de status
 *  (detecção por tabela: status ≠ sac_last_status — NÃO toca no
 *  ShopeeReturnsSyncService, zero conflito com as sessões paralelas).
 *
 *  Operador do alerta WhatsApp: REUSA a config da Central de Avaliações
 *  (review_central_config.notification_operator_id / notification_phone) —
 *  decisão de produto: é o mesmo operador de pós-venda; config própria
 *  duplicaria cadastro. O funil tem cache próprio (returns_sac_config).
 *
 *  Cron 2x/h gated por RETURNS_SAC_SYNC='on' (roda ~20min depois do
 *  shopee-returns-sync de :45). Cards são internos (CRM) — sem gate de
 *  aprovação do user. */
@Injectable()
export class ReturnsSacBridgeService {
  private readonly logger = new Logger(ReturnsSacBridgeService.name)
  private static readonly PIPELINE_NAME = 'SAC — Devoluções'
  private static readonly PIPELINE_STAGES = ['📍 Nova', '🛠️ Em tratamento', '⏳ Aguardando comprador', '✅ Resolvida']
  /** Status abertos da devolução (Shopee returns API). */
  private static readonly OPEN_STATUSES = ['REQUESTED', 'PROCESSING', 'JUDGING', 'SELLER_DISPUTE']
  /** Só devoluções recentes geram card novo (não backfilla histórico morto). */
  private static readonly NEW_CARD_WINDOW_DAYS = 60
  private static readonly BATCH = 50

  constructor(
    private readonly bridge:        ActiveBridgeClient,
    private readonly reviewCentral: ReviewCentralService,
    private readonly wa:            UnifiedWhatsAppSender,
  ) {}

  /** Etapa do funil correspondente ao status da plataforma. */
  private stageNameFor(status: string | null): string {
    switch ((status ?? '').toUpperCase()) {
      case 'REQUESTED':      return '📍 Nova'
      case 'ACCEPTED':       return '⏳ Aguardando comprador' // seller aceitou, comprador precisa devolver
      case 'REFUND_PAID':
      case 'CLOSED':
      case 'CANCELLED':      return '✅ Resolvida'
      default:               return '🛠️ Em tratamento'        // PROCESSING / JUDGING / SELLER_DISPUTE
    }
  }

  @Cron('5,35 * * * *', { name: 'returns-sac-bridge' })
  async tick(): Promise<void> {
    if (process.env.RETURNS_SAC_SYNC !== 'on') return
    const { data: rows } = await supabaseAdmin
      .from('marketplace_returns')
      .select('organization_id')
      .limit(2000)
    const orgIds = [...new Set((rows ?? []).map(r => r.organization_id as string))]
    for (const orgId of orgIds) {
      try {
        await this.syncOrg(orgId)
      } catch (e) {
        this.logger.warn(`[returns-sac] org=${orgId}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  /** Processa a org: cria cards das devoluções abertas novas + move cards
   *  cujo status mudou desde a última sync. Idempotente (dedup no Active). */
  async syncOrg(orgId: string): Promise<{ created: number; moved: number; alerts: number; skipped?: string }> {
    const cfg = await this.ensurePipeline(orgId)
    if (!cfg?.pipeline_id || !cfg.stages?.length) {
      return { created: 0, moved: 0, alerts: 0, skipped: 'Active bridge indisponível ou funil não criado' }
    }

    // nickname das lojas pro título/metadata do card
    const shopNames = await this.loadShopNames(orgId)

    // ── 1) devoluções abertas SEM card → criar ───────────────────────────────
    const windowStart = new Date(Date.now() - ReturnsSacBridgeService.NEW_CARD_WINDOW_DAYS * 86400_000).toISOString()
    const { data: fresh } = await supabaseAdmin
      .from('marketplace_returns')
      .select('*')
      .eq('organization_id', orgId)
      .is('sac_deal_id', null)
      .in('status', ReturnsSacBridgeService.OPEN_STATUSES)
      .gte('return_create_at', windowStart)
      .order('return_create_at', { ascending: false })
      .limit(ReturnsSacBridgeService.BATCH)

    let created = 0
    let alerts = 0
    for (const r of (fresh ?? []) as Json[]) {
      try {
        const dealId = await this.createReturnCard(orgId, cfg, r, shopNames)
        if (!dealId) continue
        await supabaseAdmin
          .from('marketplace_returns')
          .update({ sac_deal_id: dealId, sac_synced_at: new Date().toISOString(), sac_last_status: r.status ?? null, updated_at: new Date().toISOString() })
          .eq('id', r.id)
        created++
        if (await this.alertOperator(orgId, r, shopNames)) alerts++
      } catch (e) {
        this.logger.warn(`[returns-sac] card return_sn=${r.return_sn}: ${e instanceof Error ? e.message : e}`)
      }
    }

    // ── 2) cards existentes com status mudado → mover no funil ──────────────
    const { data: tracked } = await supabaseAdmin
      .from('marketplace_returns')
      .select('id, status, sac_deal_id, sac_last_status, return_sn')
      .eq('organization_id', orgId)
      .not('sac_deal_id', 'is', null)
      .limit(1000)

    let moved = 0
    for (const r of (tracked ?? []) as Json[]) {
      if ((r.status ?? null) === (r.sac_last_status ?? null)) continue
      try {
        const res = await this.bridge.moveCard({
          deal_id:       r.sac_deal_id,
          to_stage_name: this.stageNameFor(r.status),
        })
        // moveCard é forward-only no Active: se já passou da etapa, não regride
        // (ok pro fluxo — status Shopee só anda pra frente; logamos o motivo).
        if (res.moved) moved++
        else if (res.reason) this.logger.log(`[returns-sac] move ${r.return_sn}: ${res.reason}`)
        await supabaseAdmin
          .from('marketplace_returns')
          .update({ sac_last_status: r.status ?? null, sac_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', r.id)
      } catch (e) {
        this.logger.warn(`[returns-sac] move return_sn=${r.return_sn}: ${e instanceof Error ? e.message : e}`)
      }
    }

    if (created || moved) this.logger.log(`[returns-sac] org=${orgId} cards_criados=${created} movidos=${moved} alertas=${alerts}`)
    return { created, moved, alerts }
  }

  // ── Card de devolução ──────────────────────────────────────────────────────

  private async createReturnCard(orgId: string, cfg: SacConfig, r: Json, shopNames: Map<string, string>): Promise<string | null> {
    const stageName = this.stageNameFor(r.status)
    const stage = cfg.stages!.find(s => s.name === stageName) ?? cfg.stages![0]
    const shopName = shopNames.get(String(r.shop_id ?? '')) ?? 'Shopee'
    const raw = (r.raw ?? {}) as Json
    const photos: string[] = Array.isArray(raw.image) ? raw.image.slice(0, 5).map(String) : []
    const items = Array.isArray(raw.item)
      ? raw.item.slice(0, 5).map((it: Json) => ({ name: String(it?.name ?? '').slice(0, 120), qty: it?.amount ?? null }))
      : []
    const due = r.due_date ? new Date(r.due_date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : null

    const result = await this.bridge.createCampaignCard({
      organization_id: cfg.active_org_id ?? orgId,
      pipeline_id:     cfg.pipeline_id!,
      stage_id:        stage.id,
      title:           `↩️ ${shopName} — ${r.reason ?? 'devolução'} · ${r.buyer_username ?? 'comprador'}`,
      task_title:      `Tratar devolução ${r.return_sn}${due ? ` (prazo ${due})` : ''}`,
      value:           r.refund_amount != null ? Number(r.refund_amount) : undefined,
      due_date:        r.due_date ?? undefined,
      tags:            ['sac', 'devolucao', String(r.platform ?? 'shopee')],
      metadata: {
        return_id:       r.id,
        return_sn:       r.return_sn,
        order_sn:        r.order_sn,
        platform:        r.platform,
        shop_id:         r.shop_id,
        shop_name:       shopName,
        status:          r.status,
        reason:          r.reason,
        text_reason:     String(r.text_reason ?? '').slice(0, 500) || null,
        refund_amount:   r.refund_amount,
        currency:        r.currency,
        due_date:        r.due_date,
        tracking_number: r.tracking_number,
        buyer_username:  r.buyer_username,
        photos,
        items,
        link:            'https://eclick.app.br/dashboard/atendimento/reclamacoes',
      },
      dedup_key: `return:${r.id}`,
    })
    return result.deal_id ?? null
  }

  // ── Alerta WhatsApp do operador (reusa operador da Central de Avaliações) ──

  private async alertOperator(orgId: string, r: Json, shopNames: Map<string, string>): Promise<boolean> {
    const rcCfg = await this.reviewCentral.getConfig(orgId)
    const phone = await this.reviewCentral.resolveAlertPhone(rcCfg)
    if (!phone) {
      this.logger.log(`[returns-sac] sem WhatsApp do operador (card criado mesmo assim) org=${orgId}`)
      return false
    }
    const shopName = shopNames.get(String(r.shop_id ?? '')) ?? 'Shopee'
    const valor = r.refund_amount != null
      ? Number(r.refund_amount).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
      : '—'
    const prazo = r.due_date
      ? new Date(r.due_date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
      : null
    const msg =
      `↩️ *Nova devolução* — ${shopName}\n\n` +
      `Pedido ${r.order_sn ?? '—'} · ${r.buyer_username ?? 'comprador'}\n` +
      `Motivo: ${r.reason ?? '—'} · Valor: ${valor}${prazo ? ` · Prazo: ${prazo}` : ''}\n` +
      (r.text_reason ? `\n"${String(r.text_reason).slice(0, 200)}"\n` : '') +
      `\n📋 Card criado no funil "${ReturnsSacBridgeService.PIPELINE_NAME}" do Active.\n` +
      `🔗 eclick.app.br/dashboard/atendimento/reclamacoes`

    try {
      const res = await this.wa.send(orgId, 'internal_alert', phone, msg)
      if (res.success) return true
      this.logger.warn(`[returns-sac] alerta WA (router) falhou: ${res.error}`)
    } catch (e: unknown) {
      this.logger.warn(`[returns-sac] alerta WA (router) erro: ${(e as Error)?.message}`)
    }
    try {
      const res = await this.bridge.sendDirectMessage({
        organization_id: orgId,
        phone,
        message:   msg,
        dedup_key: `return-alert:${r.id}`,
      })
      return Boolean(res.sent)
    } catch (e: unknown) {
      this.logger.warn(`[returns-sac] alerta WA (bridge) erro: ${(e as Error)?.message}`)
      return false
    }
  }

  // ── Card manual de pedido (botão "Vincular ao SAC" da tela de pedidos) ─────

  /** Cria um card de SAC pro PEDIDO (mesmo sem devolução — ex.: cliente
   *  reclamou por fora). Dedup `order-sac:{order_id}` — clicar de novo só
   *  devolve o card existente. */
  async linkOrderSac(orgId: string, input: { source?: string; external_order_id?: string; note?: string }): Promise<{
    deal_id: string | null; created: boolean; pipeline: string
  }> {
    const source = String(input.source ?? '').trim()
    const externalId = String(input.external_order_id ?? '').trim()
    if (!source || !externalId) throw new BadRequestException('source e external_order_id são obrigatórios')

    const { data: rows } = await supabaseAdmin
      .from('orders')
      .select('external_order_id, source, platform, status, sold_at, buyer_name, buyer_username, sku, product_title, quantity, sale_price, channel_account_id')
      .eq('organization_id', orgId)
      .eq('source', source)
      .eq('external_order_id', externalId)
      .limit(20)
    if (!rows?.length) throw new NotFoundException('Pedido não encontrado nesta organização')

    const cfg = await this.ensurePipeline(orgId)
    if (!cfg?.pipeline_id || !cfg.stages?.length) {
      throw new BadRequestException('Ponte com o Active não configurada (ACTIVE_AUTOMATION_BRIDGE_URL/_SECRET)')
    }
    const stage = cfg.stages.find(s => s.name === '📍 Nova') ?? cfg.stages[0]

    const first = rows[0] as Json
    const buyer = first.buyer_name ?? first.buyer_username ?? 'comprador'
    const total = rows.reduce((acc, r: Json) => acc + (Number(r.sale_price) || 0) * (Number(r.quantity) || 1), 0)
    const channelLabel =
      source === 'mercadolivre' ? 'Mercado Livre' :
      source === 'shopee'       ? 'Shopee' :
      source === 'tiktok_shop'  ? 'TikTok Shop' :
      source === 'storefront'   ? 'Loja Própria' : source

    const result = await this.bridge.createCampaignCard({
      organization_id: cfg.active_org_id ?? orgId,
      pipeline_id:     cfg.pipeline_id,
      stage_id:        stage.id,
      title:           `🎧 SAC — Pedido ${externalId} · ${buyer}`,
      task_title:      `Atender SAC do pedido ${externalId} (${channelLabel})`,
      value:           total || undefined,
      tags:            ['sac', 'pedido', source],
      metadata: {
        order_external_id:  externalId,
        source,
        platform:           first.platform ?? source,
        channel_account_id: first.channel_account_id,
        buyer,
        status:             first.status,
        sold_at:            first.sold_at,
        total,
        items: rows.map((r: Json) => ({
          sku:        r.sku,
          title:      String(r.product_title ?? '').slice(0, 120),
          qty:        r.quantity,
          unit_price: r.sale_price,
        })),
        note: input.note ? String(input.note).slice(0, 500) : null,
        link: 'https://eclick.app.br/dashboard/pedidos',
      },
      dedup_key: `order-sac:${externalId}`,
    })
    return {
      deal_id:  result.deal_id ?? null,
      created:  result.created !== false,
      pipeline: ReturnsSacBridgeService.PIPELINE_NAME,
    }
  }

  // ── Status (smoke / tela) ──────────────────────────────────────────────────

  async status(orgId: string): Promise<Json> {
    const { count: withCard } = await supabaseAdmin
      .from('marketplace_returns')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .not('sac_deal_id', 'is', null)
    const { count: pendingOpen } = await supabaseAdmin
      .from('marketplace_returns')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .is('sac_deal_id', null)
      .in('status', ReturnsSacBridgeService.OPEN_STATUSES)
    const cfg = await this.loadConfig(orgId)
    return {
      pipeline_name:    ReturnsSacBridgeService.PIPELINE_NAME,
      pipeline_id:      cfg?.pipeline_id ?? null,
      stages:           cfg?.stages ?? null,
      cards_criados:    withCard ?? 0,
      abertas_sem_card: pendingOpen ?? 0,
      cron_gate:        process.env.RETURNS_SAC_SYNC === 'on',
    }
  }

  // ── Funil (ensure 1x + cache em returns_sac_config) ───────────────────────

  private async loadConfig(orgId: string): Promise<SacConfig | null> {
    const { data } = await supabaseAdmin
      .from('returns_sac_config')
      .select('organization_id, active_org_id, pipeline_id, stages')
      .eq('organization_id', orgId)
      .maybeSingle()
    return (data as SacConfig | null) ?? null
  }

  private async ensurePipeline(orgId: string): Promise<SacConfig | null> {
    const existing = await this.loadConfig(orgId)
    if (existing?.pipeline_id && existing.stages?.length) return existing

    const funnel = await this.bridge.ensureServicePipeline({
      organization_id: existing?.active_org_id ?? orgId,
      name:            ReturnsSacBridgeService.PIPELINE_NAME,
      stages:          ReturnsSacBridgeService.PIPELINE_STAGES,
    })
    if (!funnel.pipeline_id || !funnel.stages?.length) {
      this.logger.warn('[returns-sac] Active bridge indisponível — funil não criado')
      return null
    }
    const cfg: SacConfig = {
      organization_id: orgId,
      active_org_id:   existing?.active_org_id ?? null,
      pipeline_id:     funnel.pipeline_id,
      stages:          funnel.stages,
    }
    await supabaseAdmin
      .from('returns_sac_config')
      .upsert({ ...cfg, updated_at: new Date().toISOString() }, { onConflict: 'organization_id' })
    return cfg
  }

  private async loadShopNames(orgId: string): Promise<Map<string, string>> {
    const { data } = await supabaseAdmin
      .from('marketplace_connections')
      .select('shop_id, nickname')
      .eq('organization_id', orgId)
      .eq('platform', 'shopee')
    const map = new Map<string, string>()
    for (const c of data ?? []) {
      if (c.shop_id != null) map.set(String(c.shop_id), (c.nickname as string) ?? `Shopee #${c.shop_id}`)
    }
    return map
  }
}
