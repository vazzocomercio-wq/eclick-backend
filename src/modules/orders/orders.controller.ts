import { Controller, Get, Post, Body, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common'
import { OrdersService, CreateManualOrderDto } from './orders.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('orders')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  // POST /orders/manual
  @Post('manual')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('orders.update_status')
  createManual(
    @ReqUser() user: ReqUserPayload,
    @Body() dto: CreateManualOrderDto,
  ) {
    return this.orders.createManualOrder(user.orgId!, dto)
  }

  // GET /orders/manual?offset=0&limit=20
  @Get('manual')
  @RequirePermission('orders.view')
  getManual(
    @ReqUser() user: ReqUserPayload,
    @Query('offset') offset?: string,
    @Query('limit')  limit?: string,
  ) {
    return this.orders.getManualOrders(user.orgId!, Number(offset ?? 0), Number(limit ?? 20))
  }

  /** GET /orders/list?offset=&limit=&q=&seller_id=&tab=&platform=&account_id=
   *  Lista pedidos do DB (sales-aggregator sync) com filtro server-side
   *  por tab — corrige paginacao quando filter client-side reduzia resultados.
   *  platform=storefront lê de storefront_orders (Loja Própria).
   *  account_id = loja do canal (channel_account_id: shop_id Shopee/TikTok).
   */
  @Get('list')
  @RequirePermission('orders.view')
  listOrders(
    @ReqUser() user: ReqUserPayload,
    @Query('offset')     offset?:    string,
    @Query('limit')      limit?:     string,
    @Query('q')          q?:         string,
    @Query('seller_id')  sellerId?:  string,
    @Query('tab')        tab?:       string,
    @Query('platform')   platform?:  string,
    @Query('account_id') accountId?: string,
  ) {
    const validTabs = ['abertas','em_preparacao','despachadas','pgto_pendente','flex','encerradas','mediacao','canceladas'] as const
    const safeTab = (validTabs as readonly string[]).includes(tab ?? '')
      ? (tab as typeof validTabs[number])
      : undefined
    const safePlatform = sanitizePlatform(platform)
    return this.orders.listOrders(user.orgId, {
      offset:     offset ? Number(offset) : 0,
      limit:      limit  ? Number(limit)  : 20,
      q,
      seller_id:  sellerId ? Number(sellerId) : undefined,
      tab:        safeTab,
      platform:   safePlatform,
      account_id: accountId || undefined,
    })
  }

  /** GET /orders/list/kpis?seller_id=&platform=&account_id= */
  @Get('list/kpis')
  @RequirePermission('orders.view')
  listOrdersKpis(
    @ReqUser() user: ReqUserPayload,
    @Query('seller_id')  sellerId?:  string,
    @Query('platform')   platform?:  string,
    @Query('account_id') accountId?: string,
  ) {
    return this.orders.listOrdersKpis(
      user.orgId,
      sellerId ? Number(sellerId) : undefined,
      sanitizePlatform(platform),
      accountId || undefined,
    )
  }

  /** GET /orders/list/tab-counts?seller_id=&platform=&account_id= */
  @Get('list/tab-counts')
  @RequirePermission('orders.view')
  listOrdersTabCounts(
    @ReqUser() user: ReqUserPayload,
    @Query('seller_id')  sellerId?:  string,
    @Query('platform')   platform?:  string,
    @Query('account_id') accountId?: string,
  ) {
    return this.orders.listOrdersTabCounts(
      user.orgId,
      sellerId ? Number(sellerId) : undefined,
      sanitizePlatform(platform),
      accountId || undefined,
    )
  }

  /** GET /orders/accounts — lista contas que têm venda na org, por plataforma.
   *  Data-driven: só aparece plataforma/conta com pedido. Alimenta o seletor
   *  unificado do dashboard (ML × N contas + Shopee + TikTok + …). */
  @Get('accounts')
  @RequirePermission('orders.view')
  getAccounts(@ReqUser() user: ReqUserPayload) {
    return this.orders.getAccountsWithSales(user.orgId!)
  }

  // ── TT-5c: agnóstico de canal pra dashboard + financeiro ────────────────
  // Espelham /ml/recent-orders e /ml/financial-summary mas pra TODAS as
  // plataformas (sem exigir ML conectado).

  /** GET /orders/recent?offset=&limit=&date_from=&date_to=&seller_id=&platforms=ml,tiktok */
  @Get('recent')
  @RequirePermission('orders.view')
  getRecentOrders(
    @ReqUser() user: ReqUserPayload,
    @Query('offset')    offset?:   string,
    @Query('limit')     limit?:    string,
    @Query('date_from') dateFrom?: string,
    @Query('date_to')   dateTo?:   string,
    @Query('seller_id') sellerId?: string,
    @Query('platforms') platforms?: string,
  ) {
    const platformsList = platforms
      ? platforms.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined
    return this.orders.getRecentOrders(
      user.orgId!,
      Number(offset ?? 0),
      Number(limit ?? 50),
      dateFrom,
      dateTo,
      sellerId ? Number(sellerId) : undefined,
      platformsList,
    )
  }

  /** GET /orders/financial-summary?date_from=&date_to=&status=&seller_id=&platforms= */
  @Get('financial-summary')
  @RequirePermission('orders.view')
  getFinancialSummary(
    @ReqUser() user: ReqUserPayload,
    @Query('date_from') dateFrom: string,
    @Query('date_to')   dateTo:   string,
    @Query('status')    status?:  string,
    @Query('seller_id') sellerId?: string,
    @Query('platforms') platforms?: string,
  ) {
    const platformsList = platforms
      ? platforms.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined
    return this.orders.getFinancialSummary(
      user.orgId!,
      dateFrom,
      dateTo,
      status,
      sellerId ? Number(sellerId) : undefined,
      platformsList,
    )
  }
}

function sanitizePlatform(
  raw?: string,
): 'mercadolivre' | 'manual' | 'tiktok_shop' | 'shopee' | 'storefront' | 'all' | undefined {
  if (!raw) return undefined
  const v = raw.toLowerCase()
  if (v === 'mercadolivre' || v === 'ml')   return 'mercadolivre'
  if (v === 'manual')                       return 'manual'
  if (v === 'tiktok_shop' || v === 'tiktok') return 'tiktok_shop'
  if (v === 'shopee')                       return 'shopee'
  if (v === 'storefront' || v === 'loja')   return 'storefront'
  if (v === 'all' || v === 'todas')         return 'all'
  return undefined
}
