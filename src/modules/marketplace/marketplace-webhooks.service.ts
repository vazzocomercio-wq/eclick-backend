import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { MarketplaceAdapterRegistry } from './adapters/registry'
import { ShopeeAdapter } from './adapters/shopee.adapter'

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

  constructor(private readonly registry: MarketplaceAdapterRegistry) {}

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
    let organizationId: string | null = null
    if (shopIdStr) {
      const { data } = await supabaseAdmin
        .from('marketplace_connections')
        .select('organization_id')
        .eq('platform', 'shopee')
        .eq('shop_id', Number(shopIdStr))
        .maybeSingle()
      organizationId = (data as { organization_id: string } | null)?.organization_id ?? null
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

    // 6. Dispatcher por push_code. Real handlers em F1.x; agora só log
    //    estruturado pra debug e marca processado.
    await this.dispatchShopeeByCode({ eventId, pushCode, shopId: shopIdStr, parsed })
  }

  /** Stub dispatcher. Cada code mapeia pra um handler vertical (orders,
   *  items, escrow, NF-e). F1.x preenche. Sempre marca processed_at pra
   *  não re-tentar no replay. */
  private async dispatchShopeeByCode(input: {
    eventId:  string | null
    pushCode: number | null
    shopId:   string | null
    parsed:   ShopeeWebhookBody | null
  }): Promise<void> {
    const { eventId, pushCode, shopId } = input

    // Doc Shopee Open Platform v2 push codes (BR pode incluir extras):
    //   1  = TEST_PUSH / heartbeat                    → noop
    //   3  = ORDER_STATUS                             → F1.x orders
    //   4  = ITEM_PROMOTION                           → F1.x items
    //   5  = OPEN_API_AUTHORIZATION_EXPIRY            → marca conexão
    //   6  = ITEM_VIOLATION                           → F1.3 quality
    //   12 = AUTH_PARTNER_REVOKED                     → marca conexão
    //   15 = BRAZIL_NFE_STATUS                        → F1.x fiscal
    //   * (outros)                                    → log + audit
    const tag =
      pushCode === 1  ? 'test_push'         :
      pushCode === 3  ? 'order_status'      :
      pushCode === 4  ? 'item_promotion'    :
      pushCode === 5  ? 'auth_expiry'       :
      pushCode === 6  ? 'item_violation'    :
      pushCode === 12 ? 'auth_revoked'      :
      pushCode === 15 ? 'br_nfe_status'     :
                        `code_${pushCode ?? 'null'}`

    this.logger.log(`[shopee.webhook] dispatch ${tag} shop=${shopId ?? '?'} event=${eventId ?? '?'}`)

    // Marca processado (mesmo nos stubs — F1.x trocará por handlers reais).
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
