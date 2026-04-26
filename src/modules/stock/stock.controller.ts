import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query,
  UseGuards, HttpCode, HttpStatus,
  HttpException, Logger,
} from '@nestjs/common'
import { StockService } from './stock.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'

@Controller('stock')
@UseGuards(SupabaseAuthGuard)
export class StockController {
  private readonly logger = new Logger(StockController.name)

  constructor(private readonly svc: StockService) {}

  @Get(':product_id/full')
  full(@Param('product_id') productId: string) {
    return this.svc.getFullStock(productId)
  }

  @Patch(':stock_id/safety')
  async updateSafety(
    @Param('stock_id') stockId: string,
    @Body() body: {
      safety_mode?: 'percentage' | 'fixed'
      safety_percentage?: number
      safety_quantity?: number
    },
  ) {
    try {
      return await this.svc.updateSafety(stockId, body)
    } catch (e: any) {
      this.logger.error(`[safety] ${e?.message}`)
      if (e instanceof HttpException) throw e
      throw new HttpException(e?.message ?? 'Erro ao atualizar safety', 400)
    }
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
  async sync(@Param('product_id') productId: string) {
    try {
      await this.svc.syncStockToAllChannels(productId, 'manual_force_sync')
      return { ok: true, productId }
    } catch (e: any) {
      this.logger.error(`[sync] product=${productId}: ${e?.message}`)
      if (e instanceof HttpException) throw e
      throw new HttpException(e?.message ?? 'Erro ao sincronizar', 400)
    }
  }

  // ── Auto distribution ──────────────────────────────────────────────────────

  @Get(':product_id/auto-check')
  autoCheck(@Param('product_id') productId: string) {
    return this.svc.canUseAutoMode(productId)
  }

  @Get(':product_id/auto-preview')
  autoPreview(@Param('product_id') productId: string) {
    return this.svc.calculateAutoDistribution(productId)
  }

  @Post(':product_id/recalc-auto')
  @HttpCode(HttpStatus.OK)
  async recalcAuto(@Param('product_id') productId: string) {
    try {
      return await this.svc.applyAutoDistribution(productId, 'user_manual')
    } catch (e: any) {
      this.logger.error(`[recalc-auto] ${e?.message}`)
      throw new HttpException(e?.message ?? 'Erro ao recalcular', 400)
    }
  }

  @Get(':product_id/recalc-history')
  recalcHistory(@Param('product_id') productId: string) {
    return this.svc.getRecalcHistory(productId)
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  @Post('sync-all')
  @HttpCode(HttpStatus.OK)
  async syncAll() {
    try {
      const result = await this.svc.syncAllProductsWithMlListing()
      this.logger.log(`[sync-all] ${result.success}/${result.total} ok, ${result.errors} erro`)
      return {
        ok: true,
        ...result,
        message: `${result.success} produto(s) sincronizado(s)${result.errors > 0 ? `, ${result.errors} com erro` : ''}`,
      }
    } catch (e: any) {
      this.logger.error(`[sync-all] ${e?.message}`)
      if (e?.stack) this.logger.error(`[sync-all] STACK: ${e.stack}`)
      throw new HttpException(e?.message ?? 'Erro ao sincronizar', 400)
    }
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
