import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { MarketplaceService } from '../marketplace.service'
import { ShopeeAdapter } from '../adapters/shopee.adapter'
import { ShopeeProductSyncService } from './shopee-product-sync.service'
import { AccountLabelsService } from '../../account-labels/account-labels.service'
import type { MpConnection } from '../adapters/base'

/** Fase C pós-venda — Ingestão de DEVOLUÇÕES/reembolsos Shopee.
 *
 *  returns API (get_return_list) → upsert em `marketplace_returns` (tabela
 *  agnóstica de plataforma) + enxerto de um resumo em
 *  orders.raw_data->mediations: a tela central de pedidos já trata qualquer
 *  pedido com `mediations` não-vazio como "Mediação" (aba, contador, chip) —
 *  paridade com ML sem mudar a listagem.
 *
 *  Cron 2/2h gated por env SHOPEE_RETURN_SYNC='on' (mesmo padrão de rollout
 *  do SHOPEE_ORDER_SYNC). Janela default 30d; re-sync é idempotente. */
@Injectable()
export class ShopeeReturnsSyncService {
  private readonly logger = new Logger(ShopeeReturnsSyncService.name)
  private static readonly DEFAULT_DAYS = 30
  private static readonly PAGE_SIZE = 50
  private static readonly MAX_PAGES = 20 // safety cap (1000 devoluções/loja/janela)

  constructor(
    private readonly mp:          MarketplaceService,
    private readonly adapter:     ShopeeAdapter,
    private readonly productSync: ShopeeProductSyncService,
    private readonly accountLabels: AccountLabelsService,
  ) {}

  @Cron('45 */2 * * *', { name: 'shopee-returns-sync' })
  async syncTick(): Promise<void> {
    if (process.env.SHOPEE_RETURN_SYNC !== 'on') return
    const { data: rows } = await supabaseAdmin
      .from('marketplace_connections')
      .select('organization_id')
      .eq('platform', 'shopee')
      .eq('status', 'connected')
    const orgIds = [...new Set((rows ?? []).map(r => r.organization_id as string))]
    for (const orgId of orgIds) {
      try {
        await this.syncReturns(orgId)
      } catch (e) {
        this.logger.warn(`[shopee.returns.cron] org=${orgId}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  /** Sincroniza devoluções de TODAS as lojas Shopee da org. */
  async syncReturns(orgId: string, days = ShopeeReturnsSyncService.DEFAULT_DAYS): Promise<Array<{
    shop_id: number | null
    returns?: number
    injected?: number
    error?:   string
  }>> {
    const conns = (await this.mp.listConnections(orgId)).filter(c => c.platform === 'shopee')
    if (conns.length === 0) throw new NotFoundException('Nenhuma loja Shopee conectada nesta organização')
    const out = []
    for (const c of conns) {
      try {
        out.push(await this.syncShop(orgId, c, days))
      } catch (e) {
        this.logger.warn(`[shopee.returns] shop=${c.shop_id} falhou: ${e instanceof Error ? e.message : e}`)
        out.push({ shop_id: c.shop_id ?? null, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return out
  }

  private async syncShop(orgId: string, baseConn: MpConnection, days: number): Promise<{
    shop_id: number; returns: number; injected: number
  }> {
    const conn = await this.productSync.ensureFreshToken(baseConn)
    if (!conn.shop_id) throw new NotFoundException('Conexão Shopee sem shop_id')
    const shopId = conn.shop_id

    const from = new Date(Date.now() - days * 86400_000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all: any[] = []
    for (let page = 0; page < ShopeeReturnsSyncService.MAX_PAGES; page++) {
      const { returns, more } = await this.adapter.listReturns(conn, {
        pageNo: page, pageSize: ShopeeReturnsSyncService.PAGE_SIZE, createTimeFrom: from,
      })
      all.push(...returns)
      if (!more) break
    }

    let saved = 0
    const nowIso = new Date().toISOString()
    for (const r of all) {
      if (!r?.return_sn) continue
      const { error } = await supabaseAdmin.from('marketplace_returns').upsert(
        {
          organization_id:  orgId,
          platform:         'shopee',
          shop_id:          String(shopId),
          return_sn:        String(r.return_sn),
          order_sn:         r.order_sn ? String(r.order_sn) : null,
          status:           r.status ?? null,
          reason:           r.reason ?? null,
          text_reason:      r.text_reason ?? null,
          refund_amount:    r.refund_amount != null ? Number(r.refund_amount) : null,
          currency:         r.currency ?? null,
          needs_logistics:  r.needs_logistics ?? null,
          tracking_number:  r.tracking_number ?? null,
          buyer_username:   r.user?.username ?? null,
          due_date:         r.due_date    ? new Date(r.due_date    * 1000).toISOString() : null,
          return_create_at: r.create_time ? new Date(r.create_time * 1000).toISOString() : null,
          return_update_at: r.update_time ? new Date(r.update_time * 1000).toISOString() : null,
          raw:              r,
          updated_at:       nowIso,
        },
        { onConflict: 'organization_id,platform,return_sn' },
      )
      if (error) this.logger.warn(`[shopee.returns] upsert ${r.return_sn}: ${error.message}`)
      else saved++
    }

    const injected = await this.injectMediations(orgId, all)
    this.logger.log(`[shopee.returns] org=${orgId} shop=${shopId} returns=${saved} mediations_injetadas=${injected}`)
    return { shop_id: shopId, returns: saved, injected }
  }

  /** Enxerta resumo das devoluções em orders.raw_data->mediations (por
   *  order_sn). A tela central trata mediations não-vazio como "Mediação" —
   *  re-sync substitui só as entradas shopee_return (idempotente). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async injectMediations(orgId: string, returns: any[]): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byOrder = new Map<string, any[]>()
    for (const r of returns) {
      const sn = r?.order_sn ? String(r.order_sn) : null
      if (!sn) continue
      const list = byOrder.get(sn) ?? []
      list.push({
        type:          'shopee_return',
        return_sn:     String(r.return_sn ?? ''),
        status:        r.status ?? null,
        reason:        r.reason ?? null,
        text_reason:   r.text_reason ?? null,
        refund_amount: r.refund_amount != null ? Number(r.refund_amount) : null,
        due_date:      r.due_date    ? new Date(r.due_date    * 1000).toISOString() : null,
        date_created:  r.create_time ? new Date(r.create_time * 1000).toISOString() : null,
      })
      byOrder.set(sn, list)
    }
    if (!byOrder.size) return 0

    let injected = 0
    for (const [orderSn, meds] of byOrder) {
      const { data: rows } = await supabaseAdmin
        .from('orders')
        .select('id, raw_data')
        .eq('organization_id', orgId)
        .eq('source', 'shopee')
        .eq('external_order_id', orderSn)
      for (const row of rows ?? []) {
        const raw = (row.raw_data ?? {}) as Record<string, unknown>
        const existing = Array.isArray(raw.mediations) ? raw.mediations : []
        // preserva entradas que não são shopee_return (futuro multi-fonte)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const others = existing.filter((m: any) => m?.type !== 'shopee_return')
        const next = [...others, ...meds]
        if (JSON.stringify(existing) === JSON.stringify(next)) continue
        const { error } = await supabaseAdmin
          .from('orders')
          .update({ raw_data: { ...raw, mediations: next }, updated_at: new Date().toISOString() })
          .eq('id', row.id)
        if (error) this.logger.warn(`[shopee.returns] inject ${orderSn}: ${error.message}`)
        else injected++
      }
    }
    return injected
  }

  /** Lista devoluções pro front (tela Reclamações, canal Shopee). */
  async list(orgId: string, opts: { status?: string; shopId?: string; limit?: number } = {}): Promise<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    returns: any[]
    shops:   Array<{ shop_id: string; nickname: string }>
  }> {
    let q = supabaseAdmin
      .from('marketplace_returns')
      .select('*')
      .eq('organization_id', orgId)
      .eq('platform', 'shopee')
      .order('return_update_at', { ascending: false, nullsFirst: false })
      .limit(Math.min(opts.limit ?? 100, 300))
    if (opts.status) q = q.eq('status', opts.status)
    if (opts.shopId) q = q.eq('shop_id', opts.shopId)
    const { data, error } = await q
    if (error) throw new Error(`marketplace_returns list: ${error.message}`)

    const { data: conns } = await supabaseAdmin
      .from('marketplace_connections')
      .select('shop_id, nickname')
      .eq('organization_id', orgId)
      .eq('platform', 'shopee')
    // nome customizado (account_labels) tem prioridade sobre o nickname cru
    const labels = (await this.accountLabels.getMap(orgId))['shopee'] ?? {}
    const shops = (conns ?? [])
      .filter(c => c.shop_id != null)
      .map(c => ({
        shop_id:  String(c.shop_id),
        nickname: labels[String(c.shop_id)] ?? (c.nickname as string) ?? `Shopee #${c.shop_id}`,
      }))

    return { returns: data ?? [], shops }
  }
}
