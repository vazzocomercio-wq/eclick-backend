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

export interface LabelResult {
  format: 'ZPL' | 'PDF' | 'PNG' | 'NONE'
  storagePath: string
  trackingCode: string | null
  marketplace: string
  managed?: boolean        // true = envio gerenciado pelo ML (Full) — sem etiqueta
  note?: string
  logisticType?: string
}

/** Pedido Mercado Envios Full: o ML cuida do envio, sem etiqueta do vendedor. */
class MlFullManagedError extends Error {
  trackingCode: string | null
  constructor(message: string, trackingCode: string | null) {
    super(message)
    this.trackingCode = trackingCode
  }
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

  /** Gera/recupera a etiqueta de um pedido. Para ML busca a etiqueta REAL;
   *  pra loja/B2B gera ZPL simples. Pedido ML Full devolve format 'NONE'
   *  (envio gerenciado pelo ML — sem etiqueta do vendedor). */
  async generate(orgId: string, fo: FulfillmentOrderRow, items: Array<{ sku: string; title?: string | null; qty: number }>): Promise<LabelResult> {
    if (fo.source_type === 'marketplace' && (fo.channel ?? '') === 'mercadolivre') {
      try {
        return await this.generateMlLabel(orgId, fo)
      } catch (e) {
        if (e instanceof MlFullManagedError) {
          return { format: 'NONE', storagePath: '', trackingCode: e.trackingCode, marketplace: 'mercadolivre', managed: true, note: e.message }
        }
        // Pedido ML NÃO cai pra ZPL — uma etiqueta ZPL genérica não é válida no
        // Mercado Livre. Propaga o erro com mensagem clara pro operador.
        throw e
      }
    }
    return this.generateZplLabel(orgId, fo, items)
  }

  // ── Mercado Livre ──────────────────────────────────────────────────────
  private async generateMlLabel(orgId: string, fo: FulfillmentOrderRow): Promise<LabelResult> {
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

    // 2. shipment: logistic_type + substatus + tracking (1 chamada)
    let logisticType: string | null = null
    let substatus: string | null = null
    let trackingCode: string | null = null
    try {
      const shipRes = await axios.get(`https://api.mercadolibre.com/shipments/${shipmentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      logisticType = shipRes.data?.logistic_type ?? null
      substatus    = shipRes.data?.substatus ?? null
      trackingCode = shipRes.data?.tracking_number ?? null
    } catch { /* best-effort */ }

    // GUARD: Mercado Envios Full — o ML cuida do envio, NÃO há etiqueta pro
    // vendedor. (Módulo dedicado no roadmap F13.) Não tenta buscar etiqueta.
    if (logisticType === 'fulfillment') {
      throw new MlFullManagedError('Pedido Mercado Envios Full — envio gerenciado pelo ML, sem etiqueta pra imprimir.', trackingCode)
    }

    // 3. baixa a etiqueta PDF (Flex/Coletas/XD/Drop-off têm etiqueta do vendedor)
    let labelRes
    try {
      labelRes = await axios.get(
        `https://api.mercadolibre.com/shipment_labels?shipment_ids=${shipmentId}&response_type=pdf`,
        { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' },
      )
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status
      throw new BadRequestException(`Etiqueta ML indisponível${substatus ? ` (status do envio: ${substatus})` : ''}${status ? ` [HTTP ${status}]` : ''}. Confirme que o envio está pronto para impressão.`)
    }
    const buffer = Buffer.from(labelRes.data)
    const storagePath = `${orgId}/labels/${randomUUID()}.pdf`
    const { error } = await supabaseAdmin.storage
      .from(FULFILLMENT_BUCKET)
      .upload(storagePath, buffer, { contentType: 'application/pdf', upsert: false })
    if (error) throw new BadRequestException(`Falha ao salvar etiqueta: ${error.message}`)

    return { format: 'PDF', storagePath, trackingCode, marketplace: 'mercadolivre', logisticType: logisticType ?? undefined }
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
