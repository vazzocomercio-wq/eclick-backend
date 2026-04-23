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
}
