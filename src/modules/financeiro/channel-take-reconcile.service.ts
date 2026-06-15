import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { ChannelSettingsService, Channel } from '../channel-settings/channel-settings.service'

/** Fase 2b — Reconciliação take ESTIMADO × take REAL observado no escrow.
 *
 *  Confere se o take rate configurado (org_channel_settings / channel_fee_rules)
 *  ainda bate com a realidade do ledger (platform_charges). Calcula, por mês:
 *
 *    take_real = Σ taxas reais (platform_charges, exceto ads) ÷ Σ receita
 *
 *  no nível do canal E por faixa de ticket (mesmas faixas do channel_fee_rules).
 *  Marca `flagged` se a diferença vs o configurado passar de DIFF_ALERT_PTS,
 *  pra o take não descolar silenciosamente do real. Grava em
 *  `public.channel_take_reconciliation` (idempotente por org+canal+mês). */
@Injectable()
export class ChannelTakeReconcileService {
  private readonly logger = new Logger(ChannelTakeReconcileService.name)
  /** Faixas de ticket — espelham o seed de channel_fee_rules. */
  private static readonly BUCKETS: Array<{ label: string; min: number; max: number | null }> = [
    { label: '0-50',    min: 0,   max: 50 },
    { label: '50-150',  min: 50,  max: 150 },
    { label: '150-300', min: 150, max: 300 },
    { label: '300+',    min: 300, max: null },
  ]
  private static readonly DIFF_ALERT_PTS = 2

  constructor(private readonly channelSettings: ChannelSettingsService) {}

  /** Reconcilia UM canal/mês de uma org e persiste o resultado. */
  async reconcile(orgId: string, channel: Channel = 'shopee', month?: string) {
    const ym = month ?? prevMonthKey()
    const { start, endExcl } = monthRange(ym)

    // receita por pedido (não-cancelado) + total
    const orderRev = new Map<string, number>()
    let revenue = 0
    for await (const o of pageOrders(orgId, channel, start, endExcl)) {
      // ⚠️ orders.sale_price já é o TOTAL da linha (qty embutida na ingestão),
      // igual ao order_selling_price do escrow — NÃO multiplicar por quantity.
      const rev = num(o.sale_price)
      revenue += rev
      if (o.external_order_id) orderRev.set(o.external_order_id, (orderRev.get(o.external_order_id) ?? 0) + rev)
    }

    // taxa real por pedido (charge−credit, exceto ads) + total
    const orderFee = new Map<string, number>()
    let fees = 0
    for await (const c of pageCharges(orgId, channel, start, endExcl)) {
      if (c.charge_category === 'ads') continue
      const signed = c.detail_type === 'credit' ? -num(c.amount) : num(c.amount)
      fees += signed
      if (c.external_order_id) orderFee.set(c.external_order_id, (orderFee.get(c.external_order_id) ?? 0) + signed)
    }

    const observed = revenue > 0 ? r2((fees / revenue) * 100) : null
    const configured = await this.channelSettings.getEstimatedTakeRatePct(orgId, channel, 0)
    const diff = observed != null ? r2(observed - configured) : null
    const flagged = diff != null && Math.abs(diff) > ChannelTakeReconcileService.DIFF_ALERT_PTS

    // quebra por faixa de ticket (só pedidos com receita E taxa conhecidas)
    const byBucket = ChannelTakeReconcileService.BUCKETS.map(b => {
      let bRev = 0, bFee = 0, n = 0
      for (const [ext, rev] of orderRev) {
        if (rev < b.min || (b.max != null && rev >= b.max)) continue
        const fee = orderFee.get(ext)
        if (fee == null) continue
        bRev += rev; bFee += fee; n++
      }
      return {
        bucket: b.label,
        orders: n,
        revenue: r2(bRev),
        fees: r2(bFee),
        observed_take_pct: bRev > 0 ? r2((bFee / bRev) * 100) : null,
      }
    })

    const row = {
      organization_id: orgId,
      channel,
      period_key: ym,
      revenue: r2(revenue),
      fees: r2(fees),
      observed_take_pct: observed,
      configured_take_pct: configured,
      diff_pct: diff,
      flagged,
      by_bucket: byBucket,
      computed_at: new Date().toISOString(),
    }
    const { error } = await supabaseAdmin
      .from('channel_take_reconciliation')
      .upsert(row, { onConflict: 'organization_id,channel,period_key' })
    if (error) this.logger.error(`[reconcile] upsert org=${orgId.slice(0, 8)} ${channel} ${ym}: ${error.message}`)

    if (flagged) {
      this.logger.warn(`[reconcile] ⚠ ${channel} ${ym} org=${orgId.slice(0, 8)}: take real ${observed}% vs configurado ${configured}% (Δ ${diff} pts > ${ChannelTakeReconcileService.DIFF_ALERT_PTS}). Recalibrar org_channel_settings/channel_fee_rules.`)
    } else {
      this.logger.log(`[reconcile] ${channel} ${ym} org=${orgId.slice(0, 8)}: real ${observed}% vs config ${configured}% (Δ ${diff})`)
    }
    return row
  }

  /** Último resultado persistido (pra UI). */
  async getLatest(orgId: string, channel: Channel = 'shopee') {
    const { data } = await supabaseAdmin
      .from('channel_take_reconciliation')
      .select('*')
      .eq('organization_id', orgId)
      .eq('channel', channel)
      .order('period_key', { ascending: false })
      .limit(1)
      .maybeSingle()
    return data ?? null
  }

  /** Cron mensal dia 2 às 05:10 — reconcilia o mês anterior de Shopee de toda
   *  org com loja Shopee conectada (dia 2 dá tempo do escrow do fim do mês cair). */
  @Cron('10 5 2 * *', { name: 'channelTakeReconcileMonthly' })
  async cronMonthly(): Promise<void> {
    const { data } = await supabaseAdmin
      .from('marketplace_connections')
      .select('organization_id')
      .eq('platform', 'shopee')
      .eq('status', 'connected')
    const orgIds = [...new Set((data ?? []).map(r => (r as { organization_id: string }).organization_id))]
    for (const orgId of orgIds) {
      try { await this.reconcile(orgId, 'shopee') }
      catch (e) { this.logger.error(`[reconcile.cron] org=${orgId.slice(0, 8)}: ${(e as Error).message}`) }
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function* pageOrders(orgId: string, channel: string, startIso: string, endExclIso: string) {
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('orders')
      .select('external_order_id, sale_price, quantity')
      .eq('organization_id', orgId)
      .eq('source', channel)
      .neq('status', 'cancelled')
      .gte('sold_at', startIso)
      .lt('sold_at', endExclIso)
      .range(from, from + PAGE - 1)
    if (error) break
    const rows = (data ?? []) as Array<{ external_order_id: string | null; sale_price: number; quantity: number }>
    for (const r of rows) yield r
    if (rows.length < PAGE) break
  }
}

async function* pageCharges(orgId: string, platform: string, startIso: string, endExclIso: string) {
  const from = startIso.slice(0, 10)
  const toExcl = endExclIso.slice(0, 10)
  const PAGE = 1000
  for (let off = 0; ; off += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('platform_charges')
      .select('external_order_id, charge_category, detail_type, amount')
      .eq('organization_id', orgId)
      .eq('platform', platform)
      .gte('charge_date', from)
      .lt('charge_date', toExcl)
      .range(off, off + PAGE - 1)
    if (error) break
    const rows = (data ?? []) as Array<{ external_order_id: string | null; charge_category: string; detail_type: string; amount: number }>
    for (const r of rows) yield r
    if (rows.length < PAGE) break
  }
}

function prevMonthKey(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
}
function monthRange(ym: string): { start: string; endExcl: string } {
  const [y, m] = ym.split('-').map(Number)
  return {
    start: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
    endExcl: new Date(Date.UTC(y, m, 1)).toISOString(),
  }
}
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0 }
function r2(n: number): number { return Math.round(n * 100) / 100 }
