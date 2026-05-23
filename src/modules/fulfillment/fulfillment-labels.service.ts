import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import axios from 'axios'
import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'

export const FULFILLMENT_BUCKET = 'fulfillment-photos'

interface FulfillmentOrderRow {
  id: string
  organization_id: string
  source_type: string
  source_id: string | null
  source_order_ids: string[]
  channel: string | null
  reference: string | null
  customer: Record<string, unknown>
}

/**
 * Geração/impressão de etiqueta de envio.
 *  • Marketplace ML → busca a etiqueta real na API do Mercado Livre (PDF) via
 *    o shipment do pedido, e guarda no bucket.
 *  • Loja Própria / B2B (ou se o ML falhar) → gera uma etiqueta ZPL simples
 *    (texto, sem dependência externa) com referência + cliente + itens.
 */
@Injectable()
export class FulfillmentLabelsService {
  private readonly logger = new Logger(FulfillmentLabelsService.name)

  constructor(private readonly mercadolivre: MercadolivreService) {}

  /** Gera/recupera a etiqueta de um pedido e devolve { format, signedUrl, trackingCode }. */
  async generate(orgId: string, fo: FulfillmentOrderRow, items: Array<{ sku: string; title?: string | null; qty: number }>): Promise<{
    format: 'ZPL' | 'PDF' | 'PNG'
    storagePath: string
    trackingCode: string | null
    marketplace: string
  }> {
    if (fo.source_type === 'marketplace' && (fo.channel ?? '') === 'mercadolivre') {
      try {
        return await this.generateMlLabel(orgId, fo)
      } catch (e) {
        this.logger.warn(`[labels] etiqueta ML falhou (fallback ZPL): ${(e as Error).message}`)
        // cai pro fallback ZPL abaixo
      }
    }
    return this.generateZplLabel(orgId, fo, items)
  }

  // ── Mercado Livre ──────────────────────────────────────────────────────
  private async generateMlLabel(orgId: string, fo: FulfillmentOrderRow): Promise<{
    format: 'PDF'; storagePath: string; trackingCode: string | null; marketplace: string
  }> {
    const externalId = fo.source_id
    if (!externalId) throw new BadRequestException('Pedido ML sem external_order_id.')

    // Descobre o seller_id a partir de uma das linhas de `orders`
    let sellerId: number | undefined
    if (fo.source_order_ids?.length) {
      const { data } = await supabaseAdmin
        .from('orders')
        .select('seller_id')
        .in('id', fo.source_order_ids)
        .limit(1).maybeSingle()
      const s = (data as { seller_id: number | null } | null)?.seller_id
      if (s) sellerId = Number(s)
    }

    const { token } = await this.mercadolivre.getTokenForOrg(orgId, sellerId)

    // 1. pega o shipment do pedido
    const orderRes = await axios.get(`https://api.mercadolibre.com/orders/${externalId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const shipmentId = orderRes.data?.shipping?.id
    if (!shipmentId) throw new BadRequestException('Pedido ML sem shipment (sem etiqueta disponível).')

    // 2. tracking (best-effort)
    let trackingCode: string | null = null
    try {
      const shipRes = await axios.get(`https://api.mercadolibre.com/shipments/${shipmentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      trackingCode = shipRes.data?.tracking_number ?? null
    } catch { /* tracking é opcional */ }

    // 3. baixa a etiqueta PDF
    const labelRes = await axios.get(
      `https://api.mercadolibre.com/shipment_labels?shipment_ids=${shipmentId}&response_type=pdf`,
      { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' },
    )
    const buffer = Buffer.from(labelRes.data)
    const storagePath = `${orgId}/labels/${randomUUID()}.pdf`
    const { error } = await supabaseAdmin.storage
      .from(FULFILLMENT_BUCKET)
      .upload(storagePath, buffer, { contentType: 'application/pdf', upsert: false })
    if (error) throw new BadRequestException(`Falha ao salvar etiqueta: ${error.message}`)

    return { format: 'PDF', storagePath, trackingCode, marketplace: 'mercadolivre' }
  }

  // ── Fallback ZPL (loja própria / b2b / erro ML) ─────────────────────────
  private async generateZplLabel(orgId: string, fo: FulfillmentOrderRow, items: Array<{ sku: string; title?: string | null; qty: number }>): Promise<{
    format: 'ZPL'; storagePath: string; trackingCode: null; marketplace: string
  }> {
    const customerName = String((fo.customer as { name?: string })?.name ?? 'Cliente')
    const ref = fo.reference ?? fo.source_id ?? fo.id.slice(0, 8)
    const zpl = buildZpl({ ref, customerName, channel: fo.channel ?? fo.source_type, items })
    const buffer = Buffer.from(zpl, 'utf8')
    const storagePath = `${orgId}/labels/${randomUUID()}.zpl`
    const { error } = await supabaseAdmin.storage
      .from(FULFILLMENT_BUCKET)
      .upload(storagePath, buffer, { contentType: 'text/plain', upsert: false })
    if (error) throw new BadRequestException(`Falha ao salvar etiqueta: ${error.message}`)
    return { format: 'ZPL', storagePath, trackingCode: null, marketplace: fo.channel ?? fo.source_type }
  }

  /** Signed URL pra abrir a etiqueta (bucket privado). */
  async signedUrl(storagePath: string, ttlSeconds = 600): Promise<string | null> {
    const { data } = await supabaseAdmin.storage
      .from(FULFILLMENT_BUCKET)
      .createSignedUrl(storagePath, ttlSeconds)
    return data?.signedUrl ?? null
  }
}

function buildZpl(input: {
  ref: string; customerName: string; channel: string
  items: Array<{ sku: string; title?: string | null; qty: number }>
}): string {
  const lines: string[] = []
  lines.push('^XA')
  lines.push('^CF0,40')
  lines.push(`^FO40,40^FD${esc(input.channel.toUpperCase())} - Pedido ${esc(input.ref)}^FS`)
  lines.push('^CF0,28')
  lines.push(`^FO40,100^FD${esc(input.customerName)}^FS`)
  let y = 150
  for (const it of input.items.slice(0, 12)) {
    lines.push(`^FO40,${y}^FD${it.qty}x ${esc(it.sku)} ${esc((it.title ?? '').slice(0, 30))}^FS`)
    y += 40
  }
  // código de barras com a referência do pedido
  lines.push(`^FO40,${y + 20}^BY2^BCN,100,Y,N,N^FD${esc(input.ref)}^FS`)
  lines.push('^XZ')
  return lines.join('\n')
}

function esc(s: string): string {
  return String(s).replace(/[\^~]/g, ' ')
}
