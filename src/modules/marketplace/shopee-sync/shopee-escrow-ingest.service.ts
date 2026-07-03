import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { round2 } from '../../../common/margin'
import { supabaseAdmin } from '../../../common/supabase'
import { MarketplaceService } from '../marketplace.service'
import { MpConnection } from '../adapters/base'
import { ShopeeAdapter } from '../adapters/shopee.adapter'
import { ShopeeProductSyncService } from './shopee-product-sync.service'

/** Fase 2.3 — Ingere o REPASSE REAL (escrow) dos pedidos Shopee concluídos em
 *  `public.platform_charges` (o mesmo ledger do ML). É a fonte da verdade das
 *  taxas Shopee (comissão ~13% + serviço/frete-grátis ~18%), que NÃO existem no
 *  nível de pedido. Idempotente (upsert por org+source+source_detail_id).
 *  charge_date = sold_at do pedido (fechamento por mês civil). */
@Injectable()
export class ShopeeEscrowIngestService {
  private readonly logger = new Logger(ShopeeEscrowIngestService.name)

  constructor(
    private readonly mp:          MarketplaceService,
    private readonly adapter:     ShopeeAdapter,
    private readonly productSync: ShopeeProductSyncService,
  ) {}

  /** Ingere o escrow dos pedidos `delivered` que ainda não têm linhas de
   *  escrow. Limitado por `limit` por execução (a API é 1 call/pedido). */
  async ingest(orgId: string, opts: { limit?: number; daysBack?: number } = {}): Promise<{
    processed: number; upserted: number; skipped: number; failed: number
  }> {
    const limit    = Math.min(Math.max(opts.limit ?? 300, 1), 1000)
    const daysBack = Math.max(opts.daysBack ?? 120, 1)
    const fromIso  = new Date(Date.now() - daysBack * 86400_000).toISOString()

    // MULTI-LOJA: todas as conexões (token fresco), indexadas por shop_id. O
    // escrow é por pedido e cada pedido pertence a UMA loja — roteamos pelo
    // carimbo orders.channel_account_id (gravado na ingestão de pedidos).
    const all = await this.mp.resolveAll(orgId, 'shopee')
    if (!all.length) throw new NotFoundException('Loja Shopee não conectada nesta organização')
    const connByShop = new Map<string, MpConnection>()
    for (const { conn: c0 } of all) {
      if (!c0.shop_id) continue
      try { connByShop.set(String(c0.shop_id), await this.productSync.ensureFreshToken(c0)) }
      catch (e) { this.logger.warn(`[shopee.escrow] token shop=${c0.shop_id}: ${(e as Error).message}`) }
    }
    if (!connByShop.size) throw new NotFoundException('Nenhuma loja Shopee com token válido nesta organização')
    const fallbackConn = [...connByShop.values()][0]

    // pedidos concluídos no período (+ carimbo da loja dona)
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('external_order_id, sold_at, channel_account_id')
      .eq('organization_id', orgId)
      .eq('source', 'shopee')
      .eq('status', 'delivered')
      .gte('sold_at', fromIso)
      .order('sold_at', { ascending: false })
      .limit(2000)
    const allSns = [...new Set((orders ?? []).map(o => String((o as { external_order_id: string }).external_order_id)))]
    const soldAtBySn = new Map<string, string | null>()
    const shopBySn   = new Map<string, string | null>()
    for (const o of orders ?? []) {
      const sn = String((o as { external_order_id: string }).external_order_id)
      soldAtBySn.set(sn, (o as { sold_at: string | null }).sold_at)
      shopBySn.set(sn, (o as { channel_account_id: string | null }).channel_account_id ?? null)
    }

    // já ingeridos (escrow) → pula
    const { data: done } = await supabaseAdmin
      .from('platform_charges')
      .select('external_order_id')
      .eq('organization_id', orgId)
      .eq('source', 'shopee_escrow')
    const doneSet = new Set((done ?? []).map(r => String((r as { external_order_id: string }).external_order_id)))

    const todo = allSns.filter(sn => !doneSet.has(sn)).slice(0, limit)
    if (todo.length === 0) return { processed: 0, upserted: 0, skipped: allSns.length, failed: 0 }

    let upserted = 0, failed = 0
    const rows: Record<string, unknown>[] = []
    for (const sn of todo) {
      // conn da loja DONA do pedido; pedido antigo sem carimbo → 1ª loja.
      const ownerShop = shopBySn.get(sn)
      const conn = (ownerShop && connByShop.get(ownerShop)) || fallbackConn
      let income: Record<string, unknown> = {}
      try {
        const det = await this.adapter.getEscrowDetail(conn, sn)
        income = (det.raw ?? {}) as Record<string, unknown>
      } catch (e) {
        failed++
        this.logger.warn(`[shopee.escrow] ${sn} (shop=${ownerShop ?? '?'}): ${(e as Error).message}`)
        continue
      }
      const chargeDate = (soldAtBySn.get(sn) ?? new Date().toISOString()).slice(0, 10)
      const commission = Number(income.commission_fee ?? 0)
      const service    = Number(income.service_fee ?? 0)
      const txn        = Number(income.seller_transaction_fee ?? 0)
      const mk = (cat: string, sub: string, amount: number) => ({
        organization_id: orgId, platform: 'shopee', charge_category: cat, raw_subtype: sub,
        detail_type: 'charge', amount: Math.round(Math.abs(amount) * 100) / 100,
        external_order_id: sn, charge_date: chargeDate, period_key: chargeDate.slice(0, 7),
        source: 'shopee_escrow', source_detail_id: `${sn}:${sub}`, currency: 'BRL',
        raw: { order_selling_price: income.order_selling_price ?? null, escrow_amount: income.escrow_amount ?? null },
        fetched_at: new Date().toISOString(),
      })
      if (commission > 0) rows.push(mk('comissao', 'commission_fee', commission))
      if (service > 0)    rows.push(mk('servico', 'service_fee', service))
      if (txn > 0)        rows.push(mk('cobranca', 'seller_transaction_fee', txn))
    }

    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500)
      const { error } = await supabaseAdmin
        .from('platform_charges')
        .upsert(batch, { onConflict: 'organization_id,source,source_detail_id', ignoreDuplicates: false })
      if (error) this.logger.error(`[shopee.escrow] upsert batch ${i}: ${error.message}`)
      else upserted += batch.length
    }

    this.logger.log(`[shopee.escrow] org=${orgId.slice(0, 8)} processed=${todo.length} upserted=${upserted} failed=${failed}`)

    // Fase 2: reconcilia a tarifa REAL de volta nos pedidos (inclui backfill
    // de escrow ingerido em execuções anteriores). Best-effort.
    await this.reconcileOrders(orgId).catch(e =>
      this.logger.warn(`[shopee.escrow] reconcile falhou: ${(e as Error).message}`))

    return { processed: todo.length, upserted, skipped: allSns.length - todo.length, failed }
  }

  /** Reconciliação: aplica a tarifa REAL (escrow → platform_charges) de volta
   *  nas linhas de `orders` — a tela de pedidos passa a mostrar o dinheiro
   *  exato, não a estimativa. Distribui o total do pedido por linha
   *  proporcional ao valor (resto na última, soma fecha no centavo) e
   *  recalcula lucro bruto e margem. Idempotente: linha vira
   *  platform_fee_source='escrow' e a ingestão não regride (guard). */
  async reconcileOrders(orgId: string): Promise<{ orders: number; lines: number }> {
    const { data: chRows } = await supabaseAdmin
      .from('platform_charges')
      .select('external_order_id, amount')
      .eq('organization_id', orgId)
      .eq('source', 'shopee_escrow')
      .limit(20000)
    const realBySn = new Map<string, number>()
    for (const c of (chRows ?? []) as Array<{ external_order_id: string; amount: number }>) {
      const sn = String(c.external_order_id)
      realBySn.set(sn, round2((realBySn.get(sn) ?? 0) + Number(c.amount)))
    }
    if (!realBySn.size) return { orders: 0, lines: 0 }

    let nOrders = 0, nLines = 0
    const sns = [...realBySn.keys()]
    for (let i = 0; i < sns.length; i += 200) {
      const chunk = sns.slice(i, i + 200)
      const { data: ordRows } = await supabaseAdmin
        .from('orders')
        .select('id, external_order_id, sale_price, shipping_cost, cost_price, tax_amount')
        .eq('organization_id', orgId)
        .eq('source', 'shopee')
        .neq('platform_fee_source', 'escrow')
        .in('external_order_id', chunk)
      type Line = { id: string; external_order_id: string; sale_price: number | null; shipping_cost: number | null; cost_price: number | null; tax_amount: number | null }
      const bySn = new Map<string, Line[]>()
      for (const r of (ordRows ?? []) as Line[]) {
        const sn = String(r.external_order_id)
        if (!bySn.has(sn)) bySn.set(sn, [])
        bySn.get(sn)!.push(r)
      }

      for (const [sn, rows] of bySn) {
        const totalFee = realBySn.get(sn)
        if (totalFee == null) continue
        const totalPrice = rows.reduce((s, r) => s + (Number(r.sale_price) || 0), 0)
        let distributed = 0
        for (let j = 0; j < rows.length; j++) {
          const r = rows[j]
          const price = Number(r.sale_price) || 0
          // última linha leva o resto — a soma das linhas fecha no total real
          const fee = j === rows.length - 1
            ? round2(totalFee - distributed)
            : (totalPrice > 0 ? round2(totalFee * price / totalPrice) : 0)
          distributed = round2(distributed + fee)
          const ship = Number(r.shipping_cost) || 0
          const gross = round2(price - fee - ship)
          const patch: Record<string, unknown> = {
            platform_fee:        fee,
            gross_profit:        gross,
            platform_fee_source: 'escrow',
            updated_at:          new Date().toISOString(),
          }
          if (r.cost_price != null) {
            const margin = round2(gross - Number(r.cost_price) - (Number(r.tax_amount) || 0))
            patch.contribution_margin = margin
            patch.contribution_margin_pct = price > 0 ? round2(margin / price * 100) : 0
          }
          const { error } = await supabaseAdmin.from('orders').update(patch).eq('id', r.id)
          if (error) this.logger.warn(`[shopee.escrow] reconcile ${sn}: ${error.message}`)
          else nLines++
        }
        nOrders++
      }
    }
    if (nOrders > 0) this.logger.log(`[shopee.escrow] reconcile org=${orgId.slice(0, 8)}: ${nOrders} pedidos, ${nLines} linhas → tarifa REAL`)
    return { orders: nOrders, lines: nLines }
  }

  /** Cron diário 04:50 — ingere escrow de toda org com loja Shopee conectada. */
  @Cron('50 4 * * *', { name: 'shopeeEscrowIngestDaily' })
  async cronDaily(): Promise<void> {
    const { data } = await supabaseAdmin
      .from('marketplace_connections')
      .select('organization_id')
      .eq('platform', 'shopee')
      .eq('status', 'connected')
    const orgIds = [...new Set((data ?? []).map(r => (r as { organization_id: string }).organization_id))]
    for (const orgId of orgIds) {
      try { await this.ingest(orgId, { limit: 500 }) }
      catch (e) { this.logger.error(`[shopee.escrow.cron] org=${orgId.slice(0, 8)}: ${(e as Error).message}`) }
    }
  }
}
