import {
  Controller, Post, Get, Body, Param, UseGuards, HttpCode,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { BackfillService } from './services/backfill.service'
import { OrdersIngestionService } from './services/orders-ingestion.service'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface AuthUser {
  id: string
  orgId: string | null
}

interface BackfillBody {
  days?: number
}

@Controller('sales-aggregator')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class SalesAggregatorController {
  constructor(
    private readonly backfill: BackfillService,
    private readonly ingestion: OrdersIngestionService,
  ) {}

  // GET /sales-aggregator/sync-stats — last sync metrics for dashboards.
  @Get('sync-stats')
  @RequirePermission('financeiro.view')
  async syncStats() {
    return {
      last_sync: this.ingestion.getLastStats(),
      cron_interval_minutes: 60, // ml-billing-fetcher cron is hourly
    }
  }

  @Post('backfill')
  @HttpCode(202)
  @RequirePermission('settings.update')
  async startBackfill(
    @ReqUser() user: AuthUser,
    @Body() body: BackfillBody,
  ) {
    const days = Math.min(Math.max(body.days ?? 180, 1), 365)
    const { runId } = await this.backfill.startBackfill(user.orgId, days, user.id)
    return { runId, message: `Backfill de ${days} dias iniciado` }
  }

  @Get('status')
  @RequirePermission('financeiro.view')
  async getStatus(@ReqUser() user: AuthUser) {
    return this.backfill.getStatus(user.orgId)
  }

  @Post('run-now')
  @HttpCode(202)
  @RequirePermission('settings.update')
  async runNow(
    @ReqUser() user: AuthUser,
    @Body() body: BackfillBody,
  ) {
    const days = Math.min(Math.max(body.days ?? 3, 1), 30)
    const { runId } = await this.backfill.runManual(user.orgId, days, user.id)
    return { runId, message: `Sincronização de ${days} dias iniciada` }
  }

  @Post('sync-now')
  @HttpCode(202)
  @RequirePermission('settings.update')
  async syncNow(
    @ReqUser() user: AuthUser,
    @Body() body: BackfillBody,
  ) {
    const days = Math.min(Math.max(body.days ?? 1, 1), 7)
    const { runId } = await this.backfill.syncNow(user.orgId, days)
    return { runId, message: `Sync imediato de ${days} dia(s) iniciado` }
  }

  @Post('cancel/:runId')
  @HttpCode(200)
  @RequirePermission('settings.update')
  async cancelRun(
    @ReqUser() user: AuthUser,
    @Param('runId') runId: string,
  ) {
    await this.backfill.cancelRun(user.orgId, runId)
    return { ok: true }
  }

  /** POST /sales-aggregator/enrich-shipping — popula shipping_status
   *  via /shipments/{id} pra pedidos sem o campo. Usado pra backfill
   *  histórico além do cron horário. */
  @Post('enrich-shipping')
  @HttpCode(202)
  @RequirePermission('settings.update')
  async enrichShipping(
    @ReqUser() user: AuthUser,
    @Body() body: { limit?: number; daysBack?: number },
  ) {
    const limit    = Math.min(Math.max(body.limit ?? 200, 1), 1000)
    const daysBack = Math.min(Math.max(body.daysBack ?? 30, 1), 365)
    const result = await this.backfill.runShippingEnrich(user.orgId, { limit, daysBack })
    return { ...result, message: `Enrich shipping concluído (${result.updated} atualizados)` }
  }

  /** POST /sales-aggregator/enrich-shipping-address — popula
   *  receiver_address (state/city) em raw_data.shipping via
   *  /shipments/{id}. Necessário pro mapa "Vendas por Região" do
   *  dashboard porque pedidos novos chegam pelo webhook orders_v2 sem
   *  endereço (ML retorna `shipping: {id}` apenas em /orders/{id}). */
  @Post('enrich-shipping-address')
  @HttpCode(202)
  @RequirePermission('settings.update')
  async enrichShippingAddress(
    @ReqUser() user: AuthUser,
    @Body() body: { limit?: number; daysBack?: number },
  ) {
    const limit    = Math.min(Math.max(body.limit ?? 200, 1), 1000)
    const daysBack = Math.min(Math.max(body.daysBack ?? 30, 1), 365)
    const result = await this.backfill.runShippingAddressEnrich(user.orgId, { limit, daysBack })
    return { ...result, message: `Enrich endereços concluído (${result.updated} atualizados)` }
  }
}
