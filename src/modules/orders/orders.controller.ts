import { Controller, Get, Post, Body, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common'
import { OrdersService, CreateManualOrderDto } from './orders.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../rbac'
// F17-C: escopo por conta — import do arquivo concreto (regra anti-ciclo).
import { AccountScopeService, AccountScope } from '../rbac/account-scope.service'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('orders')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly scopes: AccountScopeService,
  ) {}

  /** F17-C: escopo por conta do user (null = irrestrito). */
  private scopeOf(user: ReqUserPayload): Promise<AccountScope | null> {
    if (!user.orgId) return Promise.resolve(null)
    return this.scopes.getScope(user.id, user.orgId)
  }

  // POST /orders/manual
  @Post('manual')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('orders.update_status')
  async createManual(
    @ReqUser() user: ReqUserPayload,
    @Body() dto: CreateManualOrderDto,
  ) {
    const scope = await this.scopeOf(user)
    return this.orders.createManualOrder(user.orgId!, dto, scope)
  }

  // GET /orders/manual?offset=0&limit=20
  @Get('manual')
  @RequirePermission('orders.view')
  async getManual(
    @ReqUser() user: ReqUserPayload,
    @Query('offset') offset?: string,
    @Query('limit')  limit?: string,
  ) {
    const scope = await this.scopeOf(user)
    return this.orders.getManualOrders(user.orgId!, Number(offset ?? 0), Number(limit ?? 20), scope)
  }

  /** GET /orders/list?offset=&limit=&q=&seller_id=&tab=&platform=&account_id=
   *  Lista pedidos do DB (sales-aggregator sync) com filtro server-side
   *  por tab — corrige paginacao quando filter client-side reduzia resultados.
   *  platform=storefront lê de storefront_orders (Loja Própria).
   *  account_id = loja do canal (channel_account_id: shop_id Shopee/TikTok).
   */
  @Get('list')
  @RequirePermission('orders.view')
  async listOrders(
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
    const scope = await this.scopeOf(user)
    return this.orders.listOrders(user.orgId, {
      offset:     offset ? Number(offset) : 0,
      limit:      limit  ? Number(limit)  : 20,
      q,
      seller_id:  sellerId ? Number(sellerId) : undefined,
      tab:        safeTab,
      platform:   safePlatform,
      account_id: accountId || undefined,
      scope,
    })
  }

  /** GET /orders/list/kpis?seller_id=&platform=&account_id= */
  @Get('list/kpis')
  @RequirePermission('orders.view')
  async listOrdersKpis(
    @ReqUser() user: ReqUserPayload,
    @Query('seller_id')  sellerId?:  string,
    @Query('platform')   platform?:  string,
    @Query('account_id') accountId?: string,
  ) {
    const scope = await this.scopeOf(user)
    return this.orders.listOrdersKpis(
      user.orgId,
      sellerId ? Number(sellerId) : undefined,
      sanitizePlatform(platform),
      accountId || undefined,
      scope,
    )
  }

  /** GET /orders/list/tab-counts?seller_id=&platform=&account_id= */
  @Get('list/tab-counts')
  @RequirePermission('orders.view')
  async listOrdersTabCounts(
    @ReqUser() user: ReqUserPayload,
    @Query('seller_id')  sellerId?:  string,
    @Query('platform')   platform?:  string,
    @Query('account_id') accountId?: string,
  ) {
    const scope = await this.scopeOf(user)
    return this.orders.listOrdersTabCounts(
      user.orgId,
      sellerId ? Number(sellerId) : undefined,
      sanitizePlatform(platform),
      accountId || undefined,
      scope,
    )
  }

  /** GET /orders/channels-overview — resumo por canal não-ML (Shopee, TikTok
   *  Shop, Loja Própria) pra tela Canais de Venda: contas conectadas, anúncios
   *  e vendas/receita do mês corrente (BRT). ML continua nos endpoints /ml/*. */
  @Get('channels-overview')
  @RequirePermission('orders.view')
  async getChannelsOverview(@ReqUser() user: ReqUserPayload) {
    const scope = await this.scopeOf(user)
    return this.orders.getChannelsOverview(user.orgId!, scope)
  }

  /** GET /orders/accounts — lista contas que têm venda na org, por plataforma.
   *  Data-driven: só aparece plataforma/conta com pedido. Alimenta o seletor
   *  unificado do dashboard (ML × N contas + Shopee + TikTok + …). */
  @Get('accounts')
  @RequirePermission('orders.view')
  async getAccounts(@ReqUser() user: ReqUserPayload) {
    const scope = await this.scopeOf(user)
    return this.orders.getAccountsWithSales(user.orgId!, scope)
  }

  // ── TT-5c: agnóstico de canal pra dashboard + financeiro ────────────────
  // Espelham /ml/recent-orders e /ml/financial-summary mas pra TODAS as
  // plataformas (sem exigir ML conectado).

  /** GET /orders/recent?offset=&limit=&date_from=&date_to=&seller_id=&platforms=ml,tiktok */
  @Get('recent')
  @RequirePermission('orders.view')
  async getRecentOrders(
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
    const scope = await this.scopeOf(user)
    return this.orders.getRecentOrders(
      user.orgId!,
      Number(offset ?? 0),
      Number(limit ?? 50),
      dateFrom,
      dateTo,
      sellerId ? Number(sellerId) : undefined,
      platformsList,
      scope,
    )
  }

  /** GET /orders/financial-summary?date_from=&date_to=&status=&seller_id=&platforms= */
  @Get('financial-summary')
  @RequirePermission('orders.view')
  async getFinancialSummary(
    @ReqUser() user: ReqUserPayload,
    @Query('date_from') dateFrom: string,
    @Query('date_to')   dateTo:   string,
    @Query('status')    status?:  string,
    @Query('seller_id') sellerId?: string,
    @Query('platforms') platforms?: string,
    @Query('kpis_only') kpisOnly?: string,
  ) {
    const platformsList = platforms
      ? platforms.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined
    const scope = await this.scopeOf(user)
    return this.orders.getFinancialSummary(
      user.orgId!,
      dateFrom,
      dateTo,
      status,
      sellerId ? Number(sellerId) : undefined,
      platformsList,
      kpisOnly === 'true',
      scope,
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
