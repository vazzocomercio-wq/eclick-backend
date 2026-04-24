import {
  Controller, Post, Get, Body, Param, UseGuards, HttpCode,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { BackfillService } from './services/backfill.service'

interface AuthUser {
  id: string
  orgId: string | null
}

interface BackfillBody {
  days?: number
}

function requireOrg(orgId: string | null): string {
  if (!orgId) throw new Error('Organização não encontrada para este usuário')
  return orgId
}

@Controller('sales-aggregator')
@UseGuards(SupabaseAuthGuard)
export class SalesAggregatorController {
  constructor(private readonly backfill: BackfillService) {}

  @Post('backfill')
  @HttpCode(202)
  async startBackfill(
    @ReqUser() user: AuthUser,
    @Body() body: BackfillBody,
  ) {
    const orgId = requireOrg(user.orgId)
    const days = Math.min(Math.max(body.days ?? 180, 1), 365)
    const { runId } = await this.backfill.startBackfill(orgId, days, user.id)
    return { runId, message: `Backfill de ${days} dias iniciado` }
  }

  @Get('status')
  async getStatus(@ReqUser() user: AuthUser) {
    const orgId = requireOrg(user.orgId)
    return this.backfill.getStatus(orgId)
  }

  @Post('run-now')
  @HttpCode(202)
  async runNow(
    @ReqUser() user: AuthUser,
    @Body() body: BackfillBody,
  ) {
    const orgId = requireOrg(user.orgId)
    const days = Math.min(Math.max(body.days ?? 3, 1), 30)
    const { runId } = await this.backfill.runManual(orgId, days, user.id)
    return { runId, message: `Sincronização de ${days} dias iniciada` }
  }

  @Post('cancel/:runId')
  @HttpCode(200)
  async cancelRun(
    @ReqUser() user: AuthUser,
    @Param('runId') runId: string,
  ) {
    const orgId = requireOrg(user.orgId)
    await this.backfill.cancelRun(orgId, runId)
    return { ok: true }
  }
}
