import { Injectable, Logger, Optional } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { EventsGateway } from '../events/events.gateway'
import { MarketplaceAdapterRegistry } from './adapters/registry'
import { ShopeeAdapter } from './adapters/shopee.adapter'
import { ShopeeOrdersIngestionService } from './shopee-sync/shopee-orders-ingestion.service'

/** F18 F0.3 — Recebe webhooks de marketplaces, valida assinatura, persiste em
 *  marketplace_webhook_events ANTES de processar (audit + replay), e
 *  dispatcha por push_code.
 *
 *  Soft-mode default: assinatura inválida ainda persiste (signature_valid=
 *  false) + retorna 200 — Shopee retry agressivo derruba a loja se 4xx.
 *  Quando logs estiverem limpos por 1-2 semanas, ligar
 *  SHOPEE_WEBHOOK_ENFORCE_SIG=true pra rejeitar 401.
 *
 *  Handlers reais de cada push_code são stubs nesta sprint (F0.3); F1.x
 *  implementa orders/items/escrow conforme cada vertical fecha. */
@Injectable()
export class MarketplaceWebhooksService {
  private readonly logger = new Logger(MarketplaceWebhooksService.name)

  constructor(
    private readonly registry: MarketplaceAdapterRegistry,
    private readonly orders:   ShopeeOrdersIngestionService,
    /** EventsModule é @Global; Optional só por segurança em testes. */
    @Optional() private readonly events?: EventsGateway,
  ) {}

  /** Entry point pra webhook Shopee. Sempre retorna 200 (mesmo em sig falha)
   *  no soft-mode — controller chama ack imediato.
   *
   *  @param input.rawBody  body cru exatamente como veio (verify callback em main.ts)
   *  @param input.headers  HTTP headers (case-insensitive)
   *  @param input.url      URL completa registrada no Partner Center (Shopee assina url|body) */
  async handleShopeeWebhook(input: {
    rawBody:  string
    headers:  Record<string, string | string[] | undefined>
    url:      string
  }): Promise<void> {
    const { rawBody, headers, url } = input

    // 1. Valida assinatura via adapter — algoritmo já implementado em F0.5
    //    ShopeeAdapter.validateWebhookSignature usa header Authorization +
    //    HMAC-SHA256(partner_key, `${url}|${body}`) com timingSafeEqual.
    const adapter = this.registry.get('shopee') as ShopeeAdapter
    let signatureValid = false
    let signatureError: string | null = null
    try {
      signatureValid = adapter.validateWebhookSignature({ url, rawBody, headers })
      if (!signatureValid) signatureError = 'HMAC mismatch ou header Authorization ausente'
    } catch (e: unknown) {
      signatureError = (e as Error)?.message ?? 'unknown'
      this.logger.warn(`[shopee.webhook] validateWebhookSignature throw: ${signatureError}`)
    }

    // 2. Parse melhor-esforço pra extrair metadados (shop_id, code) — falha
    //    de parse NÃO impede persistência (audit é prioridade).
    let parsed: ShopeeWebhookBody | null = null
    try {
      parsed = JSON.parse(rawBody) as ShopeeWebhookBody
    } catch {
      this.logger.warn(`[shopee.webhook] body não-JSON (${rawBody.length} chars)`)
    }

    const shopIdRaw    = parsed?.shop_id ?? null
    const shopIdStr    = shopIdRaw != null ? String(shopIdRaw) : null
    const pushCode     = typeof parsed?.code === 'number' ? parsed.code : null
    const signatureHdr =
      (headers['authorization'] as string | undefined) ??
      (headers['Authorization'] as string | undefined) ?? null

    // 3. Resolve org_id via shop_id (best-effort — pode ser null se loja
    //    ainda não estiver conectada; webhook entra como audit órfão).
    //    F0.8 defesa: .eq('status','connected') + order+limit em vez de
    //    maybeSingle() — UNIQUE INDEX parcial garante 1 row, mas se algum
    //    bug futuro deixar 2 rows passarem, não crashamos o webhook.
    let organizationId: string | null = null
    if (shopIdStr) {
      const { data } = await supabaseAdmin
        .from('marketplace_connections')
        .select('organization_id')
        .eq('platform', 'shopee')
        .eq('shop_id', Number(shopIdStr))
        .eq('status', 'connected')
        .order('updated_at', { ascending: false })
        .limit(1)
      const first = (data as Array<{ organization_id: string }> | null)?.[0]
      organizationId = first?.organization_id ?? null
    }

    // 4. Persiste ANTES de processar — se handler crashar, evento permanece
    //    queryable em marketplace_webhook_events.
    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('marketplace_webhook_events')
      .insert({
        platform:         'shopee',
        shop_id:          shopIdStr,
        organization_id:  organizationId,
        push_code:        pushCode,
        url,
        raw_body:         rawBody,
        signature_header: signatureHdr,
        signature_valid:  signatureValid,
        signature_error:  signatureError,
      })
      .select('id')
      .single()

    if (insertErr) {
      this.logger.error(`[shopee.webhook] insert falhou: ${insertErr.message}`)
      return
    }
    const eventId = (inserted as { id: string } | null)?.id ?? null

    // 5. Enforcement opcional. Se ENV liga, sig inválida não passa do persist.
    if (!signatureValid && process.env.SHOPEE_WEBHOOK_ENFORCE_SIG === 'true') {
      this.logger.warn(`[shopee.webhook] sig inválida + ENFORCE — skip handler (event=${eventId})`)
      return
    }

    // 6. Dispatcher por push_code — pedidos em TEMPO REAL (codes com ordersn)
    //    re-ingerem o pedido na hora; demais codes ficam no audit.
    await this.dispatchShopeeByCode({ eventId, pushCode, shopId: shopIdStr, organizationId, parsed })
  }

  /** Dispatcher. Codes com `data.ordersn` (status/rastreio/etiqueta/entrega)
   *  disparam a ingestão em tempo real do pedido — mesmo pipeline do cron,
   *  idempotente, com debounce de rajada. Sempre marca processed_at. */
  private async dispatchShopeeByCode(input: {
    eventId:        string | null
    pushCode:       number | null
    shopId:         string | null
    organizationId: string | null
    parsed:         ShopeeWebhookBody | null
  }): Promise<void> {
    const { eventId, pushCode, shopId, organizationId, parsed } = input

    // Push codes observados em prod (payloads reais 2026-06-12):
    //   1  = test_push / heartbeat                       → noop
    //   3  = ORDER_STATUS  {ordersn, status}             → re-ingestão
    //   4  = TRACKING_NO   {ordersn, tracking_no}        → re-ingestão
    //   5  = auth expiry                                  → audit
    //   7/8/9 = promoções/reserved stock                  → audit
    //   15 = SHIPPING_DOCUMENT {ordersn, status:READY}   → re-ingestão
    //        (etiqueta pronta = janela do endereço aberto!)
    //   30 = FULFILLMENT {ordersn, fulfillment_status}   → re-ingestão
    const tag =
      pushCode === 1  ? 'test_push'         :
      pushCode === 3  ? 'order_status'      :
      pushCode === 4  ? 'tracking_no'       :
      pushCode === 5  ? 'auth_expiry'       :
      pushCode === 6  ? 'item_violation'    :
      pushCode === 12 ? 'auth_revoked'      :
      pushCode === 15 ? 'shipping_document' :
      pushCode === 30 ? 'fulfillment'       :
                        `code_${pushCode ?? 'null'}`

    this.logger.log(`[shopee.webhook] dispatch ${tag} shop=${shopId ?? '?'} event=${eventId ?? '?'}`)

    // ── Pedido em tempo real ────────────────────────────────────────────────
    const ORDER_CODES = [3, 4, 15, 30]
    const orderSn = typeof parsed?.data?.ordersn === 'string' ? parsed.data.ordersn : null
    if (
      pushCode != null && ORDER_CODES.includes(pushCode) &&
      orderSn && shopId && organizationId &&
      process.env.SHOPEE_ORDER_SYNC === 'on' // mesmo gate de rollout do cron
    ) {
      try {
        const r = await this.orders.ingestSingleOrder(organizationId, shopId, orderSn)
        if (!r.ingested && r.reason !== 'debounce') {
          this.logger.warn(`[shopee.webhook] ${tag} pedido=${orderSn}: ${r.reason}`)
        }
        // Paridade com o ML: avisa a UI em tempo real (tela de pedidos e
        // dashboard escutam 'order:invalidate' e re-buscam em ~3s). Sem isso
        // a venda Shopee só aparecia no próximo polling (60s+).
        if (r.ingested) {
          this.events?.emitToOrg(organizationId, 'order:invalidate', {
            external_order_id:  orderSn,
            channel_account_id: shopId,
            topic:              `shopee_${tag}`,
            kind:               'orders',
            received_at:        new Date().toISOString(),
          })
        }
      } catch (e: unknown) {
        // erro na ingestão NÃO derruba o ack — cron horário cobre o gap
        this.logger.error(`[shopee.webhook] ingest ${orderSn} falhou: ${(e as Error)?.message ?? e}`)
      }
    }

    if (eventId) {
      await supabaseAdmin
        .from('marketplace_webhook_events')
        .update({ processed_at: new Date().toISOString() })
        .eq('id', eventId)
    }
  }
}

/** Shape best-effort do body Shopee push. Fixture real vai validar. */
interface ShopeeWebhookBody {
  shop_id?:   number | string
  code?:      number
  timestamp?: number
  data?:      Record<string, unknown>
}
