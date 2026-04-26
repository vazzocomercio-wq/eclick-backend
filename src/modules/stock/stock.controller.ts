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
    this.logger.log(`[safety] stockId=${stockId} body=${JSON.stringify(body)}`)
    try {
      const result = await this.svc.updateSafety(stockId, body)
      this.logger.log(`[safety] sucesso id=${result?.id}`)
      return result
    } catch (e: any) {
      this.logger.error(`[safety] ERRO: ${e?.message}`)
      if (e?.stack) this.logger.error(`[safety] STACK: ${e.stack}`)
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
    this.logger.log(`[sync] forçando sync para product_id=${productId}`)
    try {
      await this.svc.syncStockToAllChannels(productId, 'manual_force_sync')
      this.logger.log(`[sync] completo product_id=${productId}`)
      return { ok: true, productId }
    } catch (e: any) {
      this.logger.error(`[sync] ERRO product_id=${productId}: ${e?.message}`)
      if (e?.stack) this.logger.error(`[sync] STACK: ${e.stack}`)
      if (e instanceof HttpException) throw e
      throw new HttpException(e?.message ?? 'Erro ao sincronizar', 400)
    }
  }

  @Post('sync-all')
  @HttpCode(HttpStatus.OK)
  async syncAll() {
    this.logger.log('[sync-all] iniciando para todos os produtos vinculados ao ML')
    try {
      const result = await this.svc.syncAllProductsWithMlListing()
      this.logger.log(`[sync-all] completo: ${result.success}/${result.total} ok, ${result.errors} erro`)
      return {
        ok: true,
        ...result,
        message: `${result.success} produto(s) sincronizado(s)${result.errors > 0 ? `, ${result.errors} com erro` : ''}`,
      }
    } catch (e: any) {
      this.logger.error(`[sync-all] ERRO: ${e?.message}`)
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
