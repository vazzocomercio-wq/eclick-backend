import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common'
import { StockService } from './stock.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'

@Controller('stock')
@UseGuards(SupabaseAuthGuard)
export class StockController {
  constructor(private readonly svc: StockService) {}

  @Get(':product_id/full')
  full(@Param('product_id') productId: string) {
    return this.svc.getFullStock(productId)
  }

  @Patch(':stock_id/safety')
  updateSafety(
    @Param('stock_id') stockId: string,
    @Body() body: {
      safety_mode?: string
      safety_percentage?: number
      safety_quantity?: number
    },
  ) {
    return this.svc.updateSafety(stockId, body)
  }

  @Get('distribution/:product_id')
  distributions(@Param('product_id') productId: string) {
    return this.svc.getDistributions(productId)
  }

  @Post('distribution')
  createDistribution(@Body() body: {
    product_id: string
    channel: string
    account_id?: string
    distribution_mode?: string
    percentage?: number
    fixed_quantity?: number
    min_quantity?: number
    max_quantity?: number
    priority?: number
  }) {
    return this.svc.saveDistribution(body)
  }

  @Patch('distribution/:id')
  updateDistribution(
    @Param('id') id: string,
    @Body() body: Partial<{
      channel: string
      account_id: string
      distribution_mode: string
      percentage: number
      fixed_quantity: number
      min_quantity: number
      max_quantity: number
      priority: number
      is_active: boolean
    }>,
  ) {
    return this.svc.updateDistribution(id, body)
  }

  @Delete('distribution/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteDistribution(@Param('id') id: string) {
    return this.svc.deleteDistribution(id)
  }

  @Post('sync/:product_id')
  @HttpCode(HttpStatus.OK)
  sync(@Param('product_id') productId: string) {
    return this.svc.syncStockToAllChannels(productId)
  }

  @Get('sync-logs')
  syncLogs(
    @Query('status')  status?: string,
    @Query('channel') channel?: string,
    @Query('since')   since?: string,
    @Query('limit')   limit?: string,
  ) {
    return this.svc.getSyncLogs({
      status,
      channel,
      since,
      limit: limit ? Number(limit) : 100,
    })
  }

  @Get('reservations')
  reservations(@Query('status') status?: string) {
    return this.svc.listReservations(status)
  }

  @Post('reservations/:id/release')
  @HttpCode(HttpStatus.OK)
  releaseReservation(@Param('id') id: string) {
    return this.svc.releaseReservationById(id)
  }
}
