import { Controller, Get, Post, Body, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common'
import { OrdersService, CreateManualOrderDto } from './orders.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('orders')
@UseGuards(SupabaseAuthGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  // POST /orders/manual
  @Post('manual')
  @HttpCode(HttpStatus.CREATED)
  createManual(
    @ReqUser() user: ReqUserPayload,
    @Body() dto: CreateManualOrderDto,
  ) {
    return this.orders.createManualOrder(user.orgId!, dto)
  }

  // GET /orders/manual?offset=0&limit=20
  @Get('manual')
  getManual(
    @ReqUser() user: ReqUserPayload,
    @Query('offset') offset?: string,
    @Query('limit')  limit?: string,
  ) {
    return this.orders.getManualOrders(user.orgId!, Number(offset ?? 0), Number(limit ?? 20))
  }

  /** GET /orders/list?offset=&limit=&q=&seller_id=&tab=&platform=
   *  Lista pedidos do DB (sales-aggregator sync) com filtro server-side
   *  por tab — corrige paginacao quando filter client-side reduzia resultados.
   *  platform=storefront lê de storefront_orders (Loja Própria).
   */
  @Get('list')
  listOrders(
    @ReqUser() user: ReqUserPayload,
    @Query('offset')    offset?:   string,
    @Query('limit')     limit?:    string,
    @Query('q')         q?:        string,
    @Query('seller_id') sellerId?: string,
    @Query('tab')       tab?:      string,
    @Query('platform')  platform?: string,
  ) {
    const validTabs = ['abertas','em_preparacao','despachadas','pgto_pendente','flex','encerradas','mediacao','canceladas'] as const
    const safeTab = (validTabs as readonly string[]).includes(tab ?? '')
      ? (tab as typeof validTabs[number])
      : undefined
    const safePlatform = sanitizePlatform(platform)
    return this.orders.listOrders(user.orgId, {
      offset:    offset ? Number(offset) : 0,
      limit:     limit  ? Number(limit)  : 20,
      q,
      seller_id: sellerId ? Number(sellerId) : undefined,
      tab:       safeTab,
      platform:  safePlatform,
    })
  }

  /** GET /orders/list/kpis?seller_id=&platform= */
  @Get('list/kpis')
  listOrdersKpis(
    @ReqUser() user: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
    @Query('platform')  platform?: string,
  ) {
    return this.orders.listOrdersKpis(
      user.orgId,
      sellerId ? Number(sellerId) : undefined,
      sanitizePlatform(platform),
    )
  }

  /** GET /orders/list/tab-counts?seller_id=&platform= */
  @Get('list/tab-counts')
  listOrdersTabCounts(
    @ReqUser() user: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
    @Query('platform')  platform?: string,
  ) {
    return this.orders.listOrdersTabCounts(
      user.orgId,
      sellerId ? Number(sellerId) : undefined,
      sanitizePlatform(platform),
    )
  }
}

function sanitizePlatform(
  raw?: string,
): 'mercadolivre' | 'manual' | 'tiktok_shop' | 'storefront' | 'all' | undefined {
  if (!raw) return undefined
  const v = raw.toLowerCase()
  if (v === 'mercadolivre' || v === 'ml')   return 'mercadolivre'
  if (v === 'manual')                       return 'manual'
  if (v === 'tiktok_shop' || v === 'tiktok') return 'tiktok_shop'
  if (v === 'storefront' || v === 'loja')   return 'storefront'
  if (v === 'all' || v === 'todas')         return 'all'
  return undefined
}
