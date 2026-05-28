import {
  Controller, Post, Headers, Req, HttpCode, HttpStatus, Logger,
} from '@nestjs/common'
import { Request } from 'express'
import { Public } from '../../common/decorators/public.decorator'
import { MarketplaceWebhooksService } from './marketplace-webhooks.service'

/** F18 F0.3 — Endpoint público que recebe push da Shopee Open Platform.
 *
 *  Shopee registra a URL no Partner Center; precisa retornar 200 RÁPIDO
 *  (Shopee retry agressivo em qualquer não-2xx pode acabar com a saúde da
 *  loja). Por isso o handler é fire-and-forget: persiste primeiro, ack
 *  imediato; processador real corre em background.
 *
 *  Raw body é capturado em main.ts via verify callback do express json
 *  (escopo /webhooks/*) — Shopee assina url|body EXATAMENTE como veio. */
@Controller('webhooks')
export class MarketplaceWebhooksController {
  private readonly logger = new Logger(MarketplaceWebhooksController.name)

  constructor(private readonly svc: MarketplaceWebhooksService) {}

  /** POST /webhooks/shopee — assinatura validada via header Authorization
   *  com HMAC-SHA256(partner_key, `${url}|${body}`). URL DEVE ser a registrada
   *  no Partner Center, não a recebida no proxy (host pode diferir). */
  @Post('shopee')
  @Public()
  @HttpCode(HttpStatus.OK)
  shopeeWebhook(
    @Req()     req:     Request & { rawBody?: string },
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): { ok: true } {
    const rawBody = req.rawBody ?? ''
    if (!rawBody) {
      // Verify callback só liga pra /webhooks/* — se vier vazio é body literal
      // vazio (heartbeat) ou bug de roteamento.
      this.logger.warn('[shopee.webhook] rawBody vazio — ack mas não processa')
      return { ok: true }
    }

    // URL pra HMAC = a REGISTRADA no Partner Center, não req.url.
    // Default bate com /webhooks/shopee em api.eclick.app.br; permite override
    // pra staging/dev via env.
    const url = process.env.SHOPEE_WEBHOOK_URL
      ?? 'https://api.eclick.app.br/webhooks/shopee'

    // Fire-and-forget. Shopee espera ack rápido. Service captura tudo (rawBody
    // persiste mesmo se handler falhar).
    void this.svc.handleShopeeWebhook({ rawBody, headers, url })
      .catch((e: unknown) => {
        this.logger.error(`[shopee.webhook] handler crash: ${(e as Error)?.message ?? e}`)
      })

    return { ok: true }
  }
}
