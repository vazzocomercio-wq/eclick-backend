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

  /** GET /orders/list?offset=&limit=&q=&seller_id=&tab=
   *  Lista pedidos do DB (sales-aggregator sync) com filtro server-side
   *  por tab — corrige paginacao quando filter client-side reduzia resultados.
   */
  @Get('list')
  listOrders(
    @ReqUser() user: ReqUserPayload,
    @Query('offset')    offset?:   string,
    @Query('limit')     limit?:    string,
    @Query('q')         q?:        string,
    @Query('seller_id') sellerId?: string,
    @Query('tab')       tab?:      string,
  ) {
    const validTabs = ['abertas','em_preparacao','despachadas','pgto_pendente','flex','encerradas','mediacao'] as const
    const safeTab = (validTabs as readonly string[]).includes(tab ?? '')
      ? (tab as typeof validTabs[number])
      : undefined
    return this.orders.listOrders(user.orgId, {
      offset:    offset ? Number(offset) : 0,
      limit:     limit  ? Number(limit)  : 20,
      q,
      seller_id: sellerId ? Number(sellerId) : undefined,
      tab:       safeTab,
    })
  }

  /** GET /orders/list/kpis?seller_id= */
  @Get('list/kpis')
  listOrdersKpis(
    @ReqUser() user: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    return this.orders.listOrdersKpis(
      user.orgId,
      sellerId ? Number(sellerId) : undefined,
    )
  }
}
