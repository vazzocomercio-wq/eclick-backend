import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/** F18 F2.5 — Attribution Analytics.
 *
 *  Atribuição Shopee = cookie 7 dias. Estado dual da comissão:
 *  - pending:   clique → conversão registrada (ainda não confirmada)
 *  - confirmed: pós-entrega + pagamento (comissão liberada)
 *  - cancelled: devolução/cancelamento (comissão perdida)
 *
 *  Worker de reconciliação (reconcilePending) varre pendentes mais velhas
 *  que a ETA de entrega e poll /reports/conversions pra flipar estado —
 *  STUB até creds Affiliate API (Sprint 2).
 *
 *  Saque mínimo Shopee BR: R$30 (3000 centavos). */
@Injectable()
export class AttributionService {
  private readonly logger = new Logger(AttributionService.name)

  readonly MIN_WITHDRAW_CENTS = 3000

  /** Resumo pro dashboard de comissões: totais por estado + breakdown
   *  por canal + taxa de confirmação. */
  async summary(orgId: string): Promise<AttributionSummary> {
    const { data, error } = await supabaseAdmin
      .schema('shopee')
      .from('affiliate_conversions')
      .select('channel, state, commission_cents, order_value_cents')
      .eq('organization_id', orgId)
    if (error) {
      this.logger.error(`[attribution] summary: ${error.message}`)
      throw new Error(error.message)
    }

    const rows = (data ?? []) as ConvRow[]

    let pending = 0, confirmed = 0, cancelled = 0
    let pendingN = 0, confirmedN = 0, cancelledN = 0
    const byChannel = new Map<string, ChannelAgg>()

    for (const r of rows) {
      const c = Number(r.commission_cents ?? 0)
      const ch = byChannel.get(r.channel) ?? emptyChannel(r.channel)
      if (r.state === 'pending')        { pending += c;   pendingN++;   ch.pending_cents   += c; ch.conversions++ }
      else if (r.state === 'confirmed') { confirmed += c; confirmedN++; ch.confirmed_cents += c; ch.conversions++ }
      else if (r.state === 'cancelled') { cancelled += c; cancelledN++; ch.cancelled_cents += c; ch.conversions++ }
      ch.gmv_cents += Number(r.order_value_cents ?? 0)
      byChannel.set(r.channel, ch)
    }

    // Cliques por canal (de affiliate_links) pra calcular taxa de conversão
    const { data: linkData } = await supabaseAdmin
      .schema('shopee')
      .from('affiliate_links')
      .select('channel, clicks')
      .eq('organization_id', orgId)
    for (const l of (linkData ?? []) as Array<{ channel: string; clicks: number }>) {
      const ch = byChannel.get(l.channel) ?? emptyChannel(l.channel)
      ch.clicks += Number(l.clicks ?? 0)
      byChannel.set(l.channel, ch)
    }

    const totalDecided = confirmedN + cancelledN
    const confirmationRate = totalDecided > 0 ? confirmedN / totalDecided : null

    const channels = [...byChannel.values()]
      .map(c => ({
        ...c,
        conversion_rate: c.clicks > 0 ? c.conversions / c.clicks : null,
      }))
      .sort((a, b) => (b.confirmed_cents + b.pending_cents) - (a.confirmed_cents + a.pending_cents))

    return {
      totals: {
        pending_cents:    pending,
        confirmed_cents:  confirmed,
        cancelled_cents:  cancelled,
        pending_count:    pendingN,
        confirmed_count:  confirmedN,
        cancelled_count:  cancelledN,
        confirmation_rate: confirmationRate,
        withdrawable:     confirmed >= this.MIN_WITHDRAW_CENTS,
      },
      by_channel:         channels,
      min_withdraw_cents: this.MIN_WITHDRAW_CENTS,
    }
  }

  /** Lista conversões cruas (filtro opcional por estado/canal). */
  async list(orgId: string, state?: string, channel?: string): Promise<ConvRow[]> {
    let q = supabaseAdmin
      .schema('shopee')
      .from('affiliate_conversions')
      .select('id, sub_id, item_id, channel, order_value_cents, commission_cents, state, clicked_at, converted_at, confirmed_at')
      .eq('organization_id', orgId)
      .order('converted_at', { ascending: false, nullsFirst: false })
      .limit(200)
    if (state)   q = q.eq('state', state)
    if (channel) q = q.eq('channel', channel)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return (data ?? []) as ConvRow[]
  }

  /** STUB — reconciliação pós-entrega. Sprint 2: varre pendentes > ETA e
   *  poll Affiliate API /reports/conversions pra flipar confirmed/cancelled.
   *  Precisa de creds (App ID/Secret aprovados). */
  async reconcilePending(_orgId: string): Promise<{ reconciled: number }> {
    this.logger.warn('[attribution] reconcilePending stub — aguardando creds Affiliate API')
    return { reconciled: 0 }
  }
}

function emptyChannel(channel: string): ChannelAgg {
  return {
    channel,
    clicks:           0,
    conversions:      0,
    pending_cents:    0,
    confirmed_cents:  0,
    cancelled_cents:  0,
    gmv_cents:        0,
  }
}

interface ChannelAgg {
  channel:          string
  clicks:           number
  conversions:      number
  pending_cents:    number
  confirmed_cents:  number
  cancelled_cents:  number
  gmv_cents:        number
}

export interface AttributionSummary {
  totals: {
    pending_cents:     number
    confirmed_cents:   number
    cancelled_cents:   number
    pending_count:     number
    confirmed_count:   number
    cancelled_count:   number
    confirmation_rate: number | null
    withdrawable:      boolean
  }
  by_channel:         Array<ChannelAgg & { conversion_rate: number | null }>
  min_withdraw_cents: number
}

export interface ConvRow {
  id?:               string
  sub_id?:           string
  item_id?:          number
  channel:           string
  order_value_cents: number | null
  commission_cents:  number | null
  state:             string
  clicked_at?:       string | null
  converted_at?:     string | null
  confirmed_at?:     string | null
}
