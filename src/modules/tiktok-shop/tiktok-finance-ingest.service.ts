import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { round2 } from '../../common/margin'
import { TikTokShopService } from './tiktok-shop.service'

/**
 * Settlement REAL do TikTok Shop → ledger `platform_charges` + reconciliação
 * de volta nos pedidos (`orders.platform_fee_source='settlement'`).
 *
 * Fonte: Finance API `/finance/202309/statements` (extratos) e
 * `/finance/202309/statements/{id}/statement_transactions` (quebra por pedido).
 *
 * Identidade validada no dado real (jul/2026):
 *   settlement = revenue + fee + shipping_cost + adjustment
 * onde `fee` NÃO inclui o frete do vendedor (shipping_cost_amount é o frete
 * líquido — normalmente R$0, subsidiado). Composição do fee no BR:
 * comissão 6% (itemizada) + serviço 6% + R$4/item (não-itemizados) + afiliados.
 */

interface TtsStatement {
  id: string
  statement_time?: number
  revenue_amount?: string
  fee_amount?: string
  adjustment_amount?: string
  settlement_amount?: string
  currency?: string
}

interface TtsStatementTx {
  id: string
  type?: string
  order_id?: string
  adjustment_id?: string
  adjustment_order_id?: string
  adjustment_amount?: string
  revenue_amount?: string
  fee_amount?: string
  settlement_amount?: string
  shipping_cost_amount?: string
  platform_commission_amount?: string
  referral_fee_amount?: string
  transaction_fee_amount?: string
  affiliate_commission_amount?: string
  affiliate_ads_commission_amount?: string
  affiliate_partner_commission_amount?: string
  gross_sales_refund_amount?: string
  customer_order_refund_amount?: string
}

const num = (v: unknown): number => Number(v ?? 0) || 0

@Injectable()
export class TikTokFinanceIngestService {
  private readonly logger = new Logger(TikTokFinanceIngestService.name)

  constructor(private readonly tiktok: TikTokShopService) {}

  /** Ingere todos os statements + transações e reconcilia os pedidos. */
  async ingest(orgId: string): Promise<{ statements: number; transactions: number; charges: number; reconciled: number }> {
    // 1. Extratos (paginados, mais recentes primeiro)
    const statements: TtsStatement[] = []
    let pageToken: string | undefined
    do {
      const data = await this.tiktok.financeGet<{ statements?: TtsStatement[]; next_page_token?: string }>(
        orgId, '/finance/202309/statements',
        { page_size: 50, sort_field: 'statement_time', sort_order: 'DESC', page_token: pageToken },
      )
      statements.push(...(data.statements ?? []))
      pageToken = data.next_page_token || undefined
    } while (pageToken)

    // 2. Transações de cada extrato (quebra por pedido)
    const txs: Array<{ tx: TtsStatementTx; stmtDate: string }> = []
    for (const s of statements) {
      const stmtDate = new Date((s.statement_time ?? 0) * 1000).toISOString().slice(0, 10)
      let pt: string | undefined
      do {
        const data = await this.tiktok.financeGet<{ statement_transactions?: TtsStatementTx[]; next_page_token?: string }>(
          orgId, `/finance/202309/statements/${s.id}/statement_transactions`,
          { page_size: 50, sort_field: 'order_create_time', sort_order: 'DESC', page_token: pt },
        )
        for (const tx of data.statement_transactions ?? []) txs.push({ tx, stmtDate })
        pt = data.next_page_token || undefined
      } while (pt)
    }

    // 3. Ledger platform_charges (idempotente por transação+componente)
    const rows: Record<string, unknown>[] = []
    const nowIso = new Date().toISOString()
    const mk = (tx: TtsStatementTx, stmtDate: string, cat: string, sub: string, amount: number, orderId: string | null) => ({
      organization_id: orgId, platform: 'tiktok_shop', charge_category: cat, raw_subtype: sub,
      detail_type: amount >= 0 ? 'charge' : 'credit', amount: round2(Math.abs(amount)),
      external_order_id: orderId, charge_date: stmtDate, period_key: stmtDate.slice(0, 7),
      source: 'tiktok_settlement', source_detail_id: `${tx.id}:${sub}`, currency: 'BRL',
      raw: { revenue: tx.revenue_amount ?? null, settlement: tx.settlement_amount ?? null, type: tx.type ?? null },
      fetched_at: nowIso,
    })
    for (const { tx, stmtDate } of txs) {
      if (tx.type === 'ORDER') {
        const orderId = tx.order_id ?? null
        const comissao = -num(tx.platform_commission_amount) - num(tx.referral_fee_amount)
        const afiliados = -num(tx.affiliate_commission_amount) - num(tx.affiliate_ads_commission_amount) - num(tx.affiliate_partner_commission_amount)
        const cobranca = -num(tx.transaction_fee_amount)
        // residual do fee = taxa de serviço + fixa por item (não-itemizadas pela API)
        const servico = -num(tx.fee_amount) - comissao - afiliados - cobranca
        const frete = -num(tx.shipping_cost_amount)
        const ajuste = num(tx.adjustment_amount)
        if (Math.abs(comissao) >= 0.01)  rows.push(mk(tx, stmtDate, 'comissao', 'platform_commission', comissao, orderId))
        if (Math.abs(afiliados) >= 0.01) rows.push(mk(tx, stmtDate, 'ads', 'affiliate_commission', afiliados, orderId))
        if (Math.abs(cobranca) >= 0.01)  rows.push(mk(tx, stmtDate, 'cobranca', 'transaction_fee', cobranca, orderId))
        if (Math.abs(servico) >= 0.01)   rows.push(mk(tx, stmtDate, 'servico', 'service_and_item_fee', servico, orderId))
        if (Math.abs(frete) >= 0.01)     rows.push(mk(tx, stmtDate, 'frete', 'shipping_cost', frete, orderId))
        if (Math.abs(ajuste) >= 0.01)    rows.push(mk(tx, stmtDate, 'outros', 'order_adjustment', -ajuste, orderId))
      } else {
        // Ajustes fora de pedido (ex.: LOGISTICS_REIMBURSEMENT) — crédito/débito
        const amount = -num(tx.adjustment_amount ?? tx.settlement_amount)
        if (Math.abs(amount) < 0.01) continue
        const cat = (tx.type ?? '').includes('LOGISTICS') ? 'frete' : 'outros'
        rows.push(mk(tx, stmtDate, cat, (tx.type ?? 'adjustment').toLowerCase(), amount, tx.adjustment_order_id ?? null))
      }
    }
    let charges = 0
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500)
      const { error } = await supabaseAdmin
        .from('platform_charges')
        .upsert(batch, { onConflict: 'organization_id,source,source_detail_id', ignoreDuplicates: false })
      if (error) this.logger.error(`[tts.finance] upsert batch ${i}: ${error.message}`)
      else charges += batch.length
    }

    // 4. Reconciliação: tarifa + frete REAIS de volta nos pedidos
    const reconciled = await this.reconcileOrders(orgId, txs.map(t => t.tx))

    this.logger.log(`[tts.finance] org=${orgId.slice(0, 8)} statements=${statements.length} txs=${txs.length} charges=${charges} reconciled=${reconciled}`)
    return { statements: statements.length, transactions: txs.length, charges, reconciled }
  }

  /** Aplica tarifa e frete reais do settlement nas linhas de `orders`
   *  (proporcional por linha, resto na última) e recalcula lucro/margem.
   *  Pula pedidos com reembolso (o valor líquido não representa a venda). */
  private async reconcileOrders(orgId: string, txs: TtsStatementTx[]): Promise<number> {
    const settled = txs.filter(t =>
      t.type === 'ORDER' && t.order_id &&
      num(t.revenue_amount) > 0 && num(t.gross_sales_refund_amount) === 0,
    )
    if (!settled.length) return 0

    let nLines = 0
    for (const tx of settled) {
      const feeTotal = -num(tx.fee_amount)
      const shipTotal = -num(tx.shipping_cost_amount)
      const { data: ordRows } = await supabaseAdmin
        .from('orders')
        .select('id, sale_price, cost_price, tax_amount')
        .eq('organization_id', orgId)
        .eq('source', 'tiktok_shop')
        .eq('external_order_id', String(tx.order_id))
      type Line = { id: string; sale_price: number | null; cost_price: number | null; tax_amount: number | null }
      const lines = (ordRows ?? []) as Line[]
      if (!lines.length) continue

      const totalPrice = lines.reduce((s, r) => s + (Number(r.sale_price) || 0), 0)
      let feeDist = 0, shipDist = 0
      for (let j = 0; j < lines.length; j++) {
        const r = lines[j]
        const price = Number(r.sale_price) || 0
        const last = j === lines.length - 1
        const fee = last ? round2(feeTotal - feeDist) : (totalPrice > 0 ? round2(feeTotal * price / totalPrice) : 0)
        const ship = last ? round2(shipTotal - shipDist) : (totalPrice > 0 ? round2(shipTotal * price / totalPrice) : 0)
        feeDist = round2(feeDist + fee)
        shipDist = round2(shipDist + ship)
        const gross = round2(price - fee - ship)
        const patch: Record<string, unknown> = {
          platform_fee:        fee,
          shipping_cost:       ship,
          gross_profit:        gross,
          platform_fee_source: 'settlement',
          updated_at:          new Date().toISOString(),
        }
        if (r.cost_price != null) {
          const margin = round2(gross - Number(r.cost_price) - (Number(r.tax_amount) || 0))
          patch.contribution_margin = margin
          patch.contribution_margin_pct = price > 0 ? round2(margin / price * 100) : 0
        }
        const { error } = await supabaseAdmin.from('orders').update(patch).eq('id', r.id)
        if (error) this.logger.warn(`[tts.finance] reconcile ${tx.order_id}: ${error.message}`)
        else nLines++
      }
    }
    return nLines
  }

  /** Cron diário 05:35 — settlement de toda org com TikTok Shop conectado. */
  @Cron('35 5 * * *', { name: 'tiktokFinanceIngestDaily' })
  async cronDaily(): Promise<void> {
    if (process.env.TIKTOK_SHOP_SYNC_CRON === 'off') return
    const orgIds = await this.tiktok.getConnectedOrgIds()
    for (const orgId of orgIds) {
      try {
        await this.ingest(orgId)
      } catch (e) {
        this.logger.warn(`[tts.finance] cron org=${orgId.slice(0, 8)}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }
}
