import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { AlertSignalsService } from '../../intelligence-hub/alert-signals.service'
import type { SignalDraft } from '../../intelligence-hub/analyzers/analyzers.types'

const DEFAULT_WARNING_DAYS  = 1
const DEFAULT_CRITICAL_DAYS = 3

interface OrderRow {
  id:                       string
  organization_id:          string
  external_order_id:        string | null
  buyer_username:           string | null
  buyer_name:               string | null
  product_title:            string | null
  shipping_status:          string | null
  status:                   string | null
  raw_data:                 Record<string, unknown> | null
  source:                   string | null
  marketplace_listing_id:   string | null
}

/**
 * Cron horário que detecta pedidos ML com prazo estourado e dispara signal
 * shipping_delayed.
 *
 * `estimated_delivery_date` vive em raw_data jsonb (vem do payload ML).
 * Lemos via expressão JSONB em SQL.
 *
 * Não é polling de API ML — usamos dados que JÁ temos no banco
 * (sincronizados por outro pipeline). Política realtime-first preservada.
 */
@Injectable()
export class MlShippingDelayService {
  private readonly logger = new Logger(MlShippingDelayService.name)

  constructor(private readonly signals: AlertSignalsService) {}

  @Cron('0 * * * *', { name: 'ml-shipping-delay-check' })
  async hourlyCheck(): Promise<void> {
    if (process.env.DISABLE_ML_SHIPPING_DELAY_WORKER === 'true') return

    // Pega pedidos ML não-finalizados com data estimada no passado.
    // Usa raw_data->'shipping'->>'estimated_delivery_final'->>'date' como fonte.
    const { data, error } = await supabaseAdmin.rpc('_admin_query_sql', {
      sql: `
        SELECT id, organization_id, external_order_id, buyer_username, buyer_name,
               product_title, shipping_status, status, raw_data, source,
               marketplace_listing_id
        FROM orders
        WHERE source = 'mercadolivre'
          AND COALESCE(shipping_status, '') NOT IN ('delivered', 'not_delivered', 'cancelled')
          AND COALESCE(status, '') NOT IN ('delivered', 'cancelled')
          AND raw_data IS NOT NULL
          AND (
            (raw_data#>>'{shipping,estimated_delivery_final,date}')::timestamptz < now()
            OR (raw_data#>>'{shipping,estimated_delivery_extended,date}')::timestamptz < now()
            OR (raw_data#>>'{shipping,estimated_delivery_limit,date}')::timestamptz < now()
          )
        LIMIT 500
      `,
    })
    if (error) {
      this.logger.warn(`[ml-shipping-delay] query falhou: ${error.message}`)
      return
    }
    const rows = (data ?? []) as OrderRow[]
    if (rows.length === 0) return

    let emitted = 0
    for (const order of rows) {
      try {
        const ok = await this.processOrder(order)
        if (ok) emitted++
      } catch (e) {
        this.logger.warn(`[ml-shipping-delay] order ${order.id} falhou: ${(e as Error).message}`)
      }
    }
    if (emitted > 0) this.logger.log(`[ml-shipping-delay] emitidos=${emitted} de ${rows.length}`)
  }

  private async processOrder(order: OrderRow): Promise<boolean> {
    const estDate = pickEstimatedDate(order.raw_data)
    if (!estDate) return false

    const daysLate = Math.floor((Date.now() - estDate.getTime()) / 86_400_000)
    if (daysLate < DEFAULT_WARNING_DAYS) return false

    let severity: 'warning' | 'critical' = 'warning'
    let score = 60
    if (daysLate >= DEFAULT_CRITICAL_DAYS) {
      severity = 'critical'
      score = 85
    }

    // Anti-dup por entity (mesma order não dispara 2x no mesmo dia)
    const since = new Date(Date.now() - 24 * 3600_000).toISOString()
    const { data: recent } = await supabaseAdmin
      .from('alert_signals')
      .select('id')
      .eq('organization_id', order.organization_id)
      .eq('analyzer', 'ml')
      .eq('category', 'shipping_delayed')
      .eq('entity_id', order.id)
      .gte('created_at', since)
      .limit(1)
    if ((recent as Array<{ id: string }> | null)?.length) return false

    const buyerLabel = order.buyer_name || order.buyer_username || 'comprador'
    const draft: SignalDraft = {
      analyzer:    'ml',
      category:    'shipping_delayed',
      severity,
      score,
      entity_type: 'order',
      entity_id:   order.id,
      entity_name: order.product_title ?? null,
      data: {
        order_id:           order.id,
        external_order_id:  order.external_order_id,
        product_title:      order.product_title,
        shipping_status:    order.shipping_status,
        days_late:          daysLate,
        estimated_date:     estDate.toISOString(),
        buyer:              buyerLabel,
      },
      summary_pt:
        `📦 Pedido atrasado ${daysLate}d — ${buyerLabel}\n` +
        `${order.product_title ?? 'Produto'}\n` +
        `Status envio: ${order.shipping_status ?? 'desconhecido'}`,
      suggestion_pt: daysLate >= DEFAULT_CRITICAL_DAYS
        ? 'Crítico: contate transportadora e o comprador HOJE pra evitar reclamação automática.'
        : 'Avise o comprador proativamente; mostra que você está acompanhando.',
    }
    await this.signals.insertMany(order.organization_id, [draft])
    return true
  }
}

function pickEstimatedDate(raw: Record<string, unknown> | null): Date | null {
  if (!raw) return null
  const shipping = (raw as { shipping?: Record<string, { date?: string } | string | undefined> }).shipping
  if (!shipping) return null
  const candidates = [
    shipping.estimated_delivery_final,
    shipping.estimated_delivery_extended,
    shipping.estimated_delivery_limit,
  ]
  for (const cand of candidates) {
    const dateStr = typeof cand === 'object' ? cand?.date : null
    if (dateStr) {
      const d = new Date(dateStr)
      if (!isNaN(d.getTime())) return d
    }
  }
  return null
}
