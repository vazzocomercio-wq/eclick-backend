import {
  Controller, Get, Post, Body, Query, UseGuards, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { ShopeePromoWriteService, VoucherInput, FlashItemInput } from './shopee-promo-write.service'
import { RequirePermission, RequirePermissionGuard } from '../../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/** F18 — Campaign Center ESCRITA: voucher + flash sale direto do painel.
 *  Preview/sugestão sempre disponíveis; create/end/delete passam pela trava
 *  de margem E pelo gate env SHOPEE_PROMO_WRITE. ⚠️ writes criam promo REAL. */
@Controller('shopee/promos')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ShopeePromoWriteController {
  constructor(private readonly svc: ShopeePromoWriteService) {}

  /** Lojas da org (seletor do wizard) + estado do gate de escrita. */
  @Get('shops')
  @RequirePermission('ads.view')
  shops(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listShops(user.orgId)
  }

  /** Horários (time slots) de Oferta Relâmpago disponíveis na loja. */
  @Get('flash-slots')
  @RequirePermission('ads.view')
  flashSlots(@ReqUser() user: ReqUserPayload, @Query('shop_id') shopId?: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listFlashSlots(user.orgId, shopId ? Number(shopId) : null)
  }

  /** Preview de margem do voucher (nada é criado). */
  @Post('voucher/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('ads.view')
  voucherPreview(@ReqUser() user: ReqUserPayload, @Body() body: VoucherInput) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    this.validateVoucherShape(body)
    return this.svc.previewVoucher(user.orgId, body)
  }

  /** Cria o voucher na Shopee. ⚠️ promoção real (gate + trava de margem). */
  @Post('voucher')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('ads.create_campaign')
  createVoucher(
    @ReqUser() user: ReqUserPayload,
    @Body() body: VoucherInput & { name?: string; code?: string; start_time?: number; end_time?: number; usage_quantity?: number; accept_warning?: boolean },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    this.validateVoucherShape(body)
    if (!body.name?.trim()) throw new BadRequestException('Dê um nome ao voucher.')
    if (!body.code?.trim()) throw new BadRequestException('Defina o código do voucher (1-5 letras/números).')
    if (!body.start_time || !body.end_time) throw new BadRequestException('Defina o período (start_time/end_time).')
    if (!body.usage_quantity) throw new BadRequestException('Defina a quantidade de cupons (usage_quantity).')
    return this.svc.createVoucher(user.orgId, body as Parameters<ShopeePromoWriteService['createVoucher']>[1])
  }

  /** Encerra (ongoing) ou apaga (upcoming) um voucher. */
  @Post('voucher/end')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('ads.create_campaign')
  endVoucher(@ReqUser() user: ReqUserPayload, @Body() body: { voucher_id?: number; shop_id?: number }) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const id = Number(body?.voucher_id)
    if (!Number.isFinite(id)) throw new BadRequestException('voucher_id inválido')
    return this.svc.endVoucher(user.orgId, id, body?.shop_id ?? null)
  }

  /** Preview de margem da Oferta Relâmpago, por variação (nada é criado). */
  @Post('flash-sale/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('ads.view')
  flashPreview(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { shop_id?: number; items?: FlashItemInput[] },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    if (!Array.isArray(body?.items) || !body.items.length) throw new BadRequestException('Informe os itens (items).')
    return this.svc.previewFlashSale(user.orgId, body.shop_id ?? null, body.items)
  }

  /** Cria a Oferta Relâmpago na Shopee. ⚠️ promoção real (gate + trava). */
  @Post('flash-sale')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('ads.create_campaign')
  createFlashSale(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { shop_id?: number; timeslot_id?: number; items?: FlashItemInput[]; accept_warning?: boolean },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.timeslot_id) throw new BadRequestException('Escolha um horário (timeslot_id).')
    if (!Array.isArray(body?.items) || !body.items.length) throw new BadRequestException('Informe os itens (items).')
    return this.svc.createFlashSale(user.orgId, {
      shop_id: body.shop_id ?? null, timeslot_id: Number(body.timeslot_id),
      items: body.items, accept_warning: body.accept_warning,
    })
  }

  /** Remove uma Oferta Relâmpago (rollback). */
  @Post('flash-sale/delete')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('ads.create_campaign')
  deleteFlashSale(@ReqUser() user: ReqUserPayload, @Body() body: { flash_sale_id?: number; shop_id?: number }) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const id = Number(body?.flash_sale_id)
    if (!Number.isFinite(id)) throw new BadRequestException('flash_sale_id inválido')
    return this.svc.deleteFlashSale(user.orgId, id, body?.shop_id ?? null)
  }

  /** IA — sugere % ideal de desconto por item (giro × margem × elasticidade). */
  @Post('suggest')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('ads.view')
  suggest(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { item_ids?: number[]; vehicle?: string },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    if (!Array.isArray(body?.item_ids) || !body.item_ids.length) throw new BadRequestException('Informe item_ids.')
    const vehicle = body.vehicle === 'flash_sale' ? 'flash_sale' as const : 'voucher' as const
    return this.svc.suggestDiscount(user.orgId, body.item_ids.map(Number), vehicle)
  }

  private validateVoucherShape(body: VoucherInput): void {
    if (body?.voucher_type !== 1 && body?.voucher_type !== 2) throw new BadRequestException('voucher_type: 1 (loja toda) ou 2 (produtos).')
    if (body?.reward_type !== 1 && body?.reward_type !== 2) throw new BadRequestException('reward_type: 1 (R$ fixo) ou 2 (percentual).')
    if (body.reward_type === 2 && body.percentage == null) throw new BadRequestException('Informe o percentual de desconto (percentage).')
    if (body.reward_type === 1 && body.discount_amount == null) throw new BadRequestException('Informe o valor do desconto em R$ (discount_amount).')
    if (body.min_basket_price == null) throw new BadRequestException('Informe o pedido mínimo (min_basket_price) — pode ser 0.')
  }
}
