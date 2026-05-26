import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import {
  AnalyticsAccountsService,
  type AnalyticsAccount,
  type AnalyticsNetwork,
} from './analytics-accounts.service'

interface ReqUserPayload { id: string; orgId: string }

/**
 * Analytics Hub — registro de contas. Backbone multi-conta/multi-rede:
 * devolve toda identidade conectada da org normalizada, pros coletores
 * iterarem e pra UI mostrar "suas contas conectadas". Org vem do JWT.
 */
@Controller('analytics')
@UseGuards(SupabaseAuthGuard)
export class AnalyticsAccountsController {
  constructor(private readonly accounts: AnalyticsAccountsService) {}

  @Get('accounts')
  async list(
    @ReqUser() user: ReqUserPayload,
    @Query('network') network?: AnalyticsNetwork,
  ): Promise<{ accounts: AnalyticsAccount[]; total: number }> {
    const accounts = await this.accounts.listAccounts(user.orgId, network)
    return { accounts, total: accounts.length }
  }
}
