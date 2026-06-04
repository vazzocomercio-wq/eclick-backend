import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import type { ShipmentEvent, ShipmentStatus } from './providers/shipping-provider.types'

/** Mapeia o status do evento pra coluna de timestamp correspondente. */
const STATUS_TS: Partial<Record<ShipmentStatus, string>> = {
  label_ready: 'label_ready_at',
  posted:      'posted_at',
  delivered:   'delivered_at',
}

interface ShipmentLinks {
  identificationId?:   string
  orderId?:            string
  fulfillmentOrderId?: string
}

/**
 * Persiste o ciclo de vida de transportadora na tabela `shipments` a partir de
 * `ShipmentEvent`s normalizados (vindos de webhook de provider ou registro
 * manual). A ligação com o funil dropship (promover identification, gravar
 * partner/channel shipped) entra nas fases F5/F6 — aqui só a base de rastreio.
 */
@Injectable()
export class ShipmentsService {
  private readonly logger = new Logger(ShipmentsService.name)

  async recordEvent(
    orgId: string,
    event: ShipmentEvent,
    links?: ShipmentLinks,
  ): Promise<{ id: string; status: ShipmentStatus }> {
    if (!orgId) throw new BadRequestException('orgId obrigatório')
    if (!event?.provider || !event?.status) {
      throw new BadRequestException('provider e status obrigatórios')
    }

    const occurredAt = event.occurredAt ?? new Date().toISOString()
    const patch: Record<string, unknown> = {
      organization_id: orgId,
      provider:        event.provider,
      status:          event.status,
      updated_at:      new Date().toISOString(),
    }
    if (event.externalId)   patch.external_id   = event.externalId
    if (event.trackingCode) patch.tracking_code = event.trackingCode
    if (event.trackingUrl)  patch.tracking_url  = event.trackingUrl
    if (event.carrier)      patch.carrier       = event.carrier
    if (event.service)      patch.service       = event.service
    if (typeof event.freightCost === 'number') patch.freight_cost = event.freightCost
    if (event.raw)          patch.raw           = event.raw

    const tsCol = STATUS_TS[event.status]
    if (tsCol) patch[tsCol] = occurredAt

    if (links?.identificationId)   patch.identification_id    = links.identificationId
    if (links?.orderId)            patch.order_id             = links.orderId
    if (links?.fulfillmentOrderId) patch.fulfillment_order_id = links.fulfillmentOrderId

    // Idempotente por (provider, external_id) quando há external_id; senão insert.
    const query = event.externalId
      ? supabaseAdmin.from('shipments').upsert(patch, { onConflict: 'provider,external_id' })
      : supabaseAdmin.from('shipments').insert(patch)

    const { data, error } = await query.select('id, status').single()
    if (error) {
      this.logger.warn(`[shipments] recordEvent falhou (${event.provider}/${event.status}): ${error.message}`)
      throw new BadRequestException(error.message)
    }
    return { id: data.id as string, status: data.status as ShipmentStatus }
  }
}
