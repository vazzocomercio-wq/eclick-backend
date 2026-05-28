import {
  Controller,
  Get,
  Post,
  Body,
  Headers,
  Param,
  Query,
  Res,
  UseGuards,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import type { Response } from 'express'
import { TikTokShopService } from './tiktok-shop.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { Public } from '../../common/decorators/public.decorator'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload {
  id: string
  orgId: string | null
}

/**
 * TikTok Shop (Personalizado) — Fase 1: OAuth.
 *
 *  GET  /tiktok-shop/oauth/auth-url   (auth)   → URL de autorização
 *  GET  /tiktok-shop/oauth/callback   (public) → TikTok Shop chama
 *  GET  /tiktok-shop/status           (auth)
 *  POST /tiktok-shop/disconnect       (auth)
 */
@Controller('tiktok-shop')
export class TikTokShopController {
  constructor(private readonly svc: TikTokShopService) {}

  /** Front chama, recebe a URL e faz window.location.href. */
  @Get('oauth/auth-url')
  @UseGuards(SupabaseAuthGuard)
  authUrl(
    @ReqUser() u: ReqUserPayload,
    @Query('redirect_to') redirectTo?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.buildAuthorizeUrl(u.orgId, u.id, redirectTo)
  }

  /** TikTok Shop redireciona pra cá com code+state. */
  @Get('oauth/callback')
  @Public()
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const frontendBase = process.env.FRONTEND_URL ?? 'https://eclick.app.br'
    const dest = '/dashboard/integracoes/tiktok-shop'
    if (!code || !state) {
      return res.redirect(`${frontendBase}${dest}?tiktok_shop=error&reason=missing_code_or_state`)
    }
    try {
      const r = await this.svc.exchangeCode(code, state)
      const base = r.redirect_to
        ? `${frontendBase}${r.redirect_to.startsWith('/') ? '' : '/'}${r.redirect_to}`
        : `${frontendBase}${dest}`
      const sep = base.includes('?') ? '&' : '?'
      return res.redirect(`${base}${sep}tiktok_shop=connected`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'erro'
      return res.redirect(`${frontendBase}${dest}?tiktok_shop=error&reason=${encodeURIComponent(msg)}`)
    }
  }

  /** Webhook do TikTok Shop (tempo real). Público — autenticado por secret na
   *  URL (?key=) + assinatura HMAC. Responde 200 na hora e processa async
   *  (TikTok espera ack rápido). Faz sync ALVO do pedido/produto do evento. */
  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  webhook(
    @Body() body: { type?: number; shop_id?: string | number; data?: Record<string, unknown> },
    @Query('key') key?: string,
    @Headers('authorization') auth?: string,
    @Headers('x-tts-signature') xsig?: string,
  ) {
    if (!this.svc.isWebhookSecretValid(key)) {
      throw new BadRequestException('webhook key inválida')
    }
    const sigOk = this.svc.verifyWebhookSignature(JSON.stringify(body ?? {}), xsig ?? auth)
    if (!sigOk && process.env.TIKTOK_SHOP_WEBHOOK_ENFORCE_SIG === 'true') {
      throw new BadRequestException('assinatura inválida')
    }
    // ack imediato + processa em background (não bloqueia a resposta)
    void this.svc.handleWebhook(body).catch(() => undefined)
    return { ok: true }
  }

  @Get('status')
  @UseGuards(SupabaseAuthGuard)
  status(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getStatus(u.orgId)
  }

  /** Lista as lojas autorizadas (chamada assinada) e guarda o shop_cipher. */
  @Get('shops')
  @UseGuards(SupabaseAuthGuard)
  shops(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getAuthorizedShops(u.orgId)
  }

  /** Importa pedidos do TikTok Shop pra tabela isolada (tiktok_shop_orders). */
  @Post('orders/import')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  importOrders(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.importOrders(u.orgId)
  }

  /** Lista os pedidos já importados. */
  @Get('orders')
  @UseGuards(SupabaseAuthGuard)
  orders(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listOrders(u.orgId)
  }

  /** Importa produtos do TikTok Shop pra tabela isolada (tiktok_shop_products). */
  @Post('products/import')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  importProducts(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.importProducts(u.orgId)
  }

  /** Lista os produtos já importados. */
  @Get('products')
  @UseGuards(SupabaseAuthGuard)
  products(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listProducts(u.orgId)
  }

  // ── Fase 4: publicar produto — base de PREVIEW (read-only, NÃO publica) ────

  /** Categorias do TikTok Shop (pt-BR), filtra por ?keyword= e ?leaf=true. */
  @Get('publish/categories')
  @UseGuards(SupabaseAuthGuard)
  categories(
    @ReqUser() u: ReqUserPayload,
    @Query('keyword') keyword?: string,
    @Query('leaf') leaf?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getCategories(u.orgId, { keyword, leafOnly: leaf === 'true' })
  }

  /** Atributos (required/opcional + valores) de uma categoria. */
  @Get('publish/categories/:id/attributes')
  @UseGuards(SupabaseAuthGuard)
  categoryAttributes(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getCategoryAttributes(u.orgId, id)
  }

  /** Recomenda categoria a partir do nome (best-effort). */
  @Post('publish/recommend-category')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  recommendCategory(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { product_name: string; description?: string },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.recommendCategory(u.orgId, body)
  }

  /** PREVIEW: mapeia o produto pro payload do TikTok + atributos faltando. NÃO publica. */
  @Post('publish/preview')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  previewPublish(
    @ReqUser() u: ReqUserPayload,
    @Body()
    body: {
      product_name: string
      description?: string
      images?: string[]
      price?: number
      sku?: string
      stock?: number
      category_id?: string
    },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.previewPublish(u.orgId, body)
  }

  /** PUBLICA de verdade: sobe as imagens e cria o anúncio no TikTok Shop.
   *  Ação explícita do usuário (cria conteúdo público). `dry_run` testa sem criar. */
  @Post('publish')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  publish(
    @ReqUser() u: ReqUserPayload,
    @Body()
    body: {
      title: string
      description?: string
      category_id: string
      image_urls: string[]
      price: number
      stock?: number
      sku?: string
      package_weight_kg?: number
      package_dimensions_cm?: { length: number; width: number; height: number }
      ml_attributes?: Array<{ id: string; value_name?: string; value_id?: string }>
      brand_name?: string
      dry_run?: boolean
    },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.publishProduct(u.orgId, body)
  }

  /** Contadores por aba (Ativos/Pausados/Finalizados/Em revisão). Estático
   *  ANTES de qualquer rota dinâmica pra não ser capturado por param. */
  @Get('listings/counts')
  @UseGuards(SupabaseAuthGuard)
  listingCounts(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listingCounts(u.orgId)
  }

  /** Anúncios TikTok no nível do SKU (página de Anúncios). */
  @Get('listings')
  @UseGuards(SupabaseAuthGuard)
  listings(
    @ReqUser() u: ReqUserPayload,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listListings(u.orgId, {
      status,
      q,
      offset: offset ? Number(offset) : undefined,
      limit: limit ? Number(limit) : undefined,
    })
  }

  // ── TT-3: escrita no TikTok (preço + ativar/pausar) — ação do usuário ──────

  /** Atualiza o preço de UM sku no anúncio TikTok (escrita real). */
  @Post('listings/:productId/price')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  updatePrice(
    @ReqUser() u: ReqUserPayload,
    @Param('productId') productId: string,
    @Body() body: { sku_id: string; price: number; currency?: string },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.sku_id) throw new BadRequestException('sku_id obrigatório')
    return this.svc.updateSkuPrice(u.orgId, productId, body.sku_id, Number(body.price), body.currency)
  }

  /** Ativa o produto no TikTok. */
  @Post('listings/:productId/activate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  activateListing(@ReqUser() u: ReqUserPayload, @Param('productId') productId: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.setProductsActive(u.orgId, [productId], true)
  }

  /** Desativa (pausa) o produto no TikTok. */
  @Post('listings/:productId/deactivate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  deactivateListing(@ReqUser() u: ReqUserPayload, @Param('productId') productId: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.setProductsActive(u.orgId, [productId], false)
  }

  @Post('disconnect')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  disconnect(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.disconnect(u.orgId)
  }
}
