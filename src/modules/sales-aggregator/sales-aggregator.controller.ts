import {
  Controller, Post, Get, Body, Param, UseGuards, HttpCode,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { BackfillService } from './services/backfill.service'
import { OrdersIngestionService } from './services/orders-ingestion.service'

interface AuthUser {
  id: string
  orgId: string | null
}

interface BackfillBody {
  days?: number
}

@Controller('sales-aggregator')
@UseGuards(SupabaseAuthGuard)
export class SalesAggregatorController {
  constructor(
    private readonly backfill: BackfillService,
    private readonly ingestion: OrdersIngestionService,
  ) {}

  // GET /sales-aggregator/sync-stats — last sync metrics for dashboards.
  @Get('sync-stats')
  async syncStats() {
    return {
      last_sync: this.ingestion.getLastStats(),
      cron_interval_minutes: 60, // ml-billing-fetcher cron is hourly
    }
  }

  @Post('backfill')
  @HttpCode(202)
  async startBackfill(
    @ReqUser() user: AuthUser,
    @Body() body: BackfillBody,
  ) {
    const days = Math.min(Math.max(body.days ?? 180, 1), 365)
    const { runId } = await this.backfill.startBackfill(user.orgId, days, user.id)
    return { runId, message: `Backfill de ${days} dias iniciado` }
  }

  @Get('status')
  async getStatus(@ReqUser() user: AuthUser) {
    return this.backfill.getStatus(user.orgId)
  }

  @Post('run-now')
  @HttpCode(202)
  async runNow(
    @ReqUser() user: AuthUser,
    @Body() body: BackfillBody,
  ) {
    const days = Math.min(Math.max(body.days ?? 3, 1), 30)
    const { runId } = await this.backfill.runManual(user.orgId, days, user.id)
    return { runId, message: `Sincronização de ${days} dias iniciada` }
  }

  // POST /sales-aggregator/sync-now — alias semântico de run-now com
  // default de 1 dia. Usado por ops/scripts pra disparar sync imediato
  // sem esperar o cron das 02h ou o horário do :17min.
  @Post('sync-now')
  @HttpCode(202)
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
  async cancelRun(
    @ReqUser() user: AuthUser,
    @Param('runId') runId: string,
  ) {
    await this.backfill.cancelRun(user.orgId, runId)
    return { ok: true }
  }
}
