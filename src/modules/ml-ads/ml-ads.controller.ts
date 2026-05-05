import {
  Controller, Get, Post, Param, Query, UseGuards, HttpCode, HttpStatus,
  BadRequestException,
} from '@nestjs/common'
import { MlAdsService } from './ml-ads.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

const EMPTY_SUMMARY = {
  totals: {
    clicks: 0, impressions: 0, spend: 0,
    conversions: 0, revenue: 0,
    ctr: 0, roas: 0, acos: 0,
  },
  series: [] as Array<unknown>,
}

@Controller('ml-ads')
@UseGuards(SupabaseAuthGuard)
export class MlAdsController {
  constructor(private readonly svc: MlAdsService) {}

  @Get('advertiser')
  async advertiser(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    try {
      return await this.svc.getAdvertiser(u.orgId)
    } catch (e: unknown) {
      const err = e as Error
      console.error('[ml-ads] advertiser erro:', err?.message)
      if (err?.stack) console.error(err.stack)
      return null
    }
  }

  @Get('campaigns')
  async getCampaigns(
    @ReqUser() u: ReqUserPayload,
    @Query('from') dateFrom?: string,
    @Query('to')   dateTo?:   string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    try {
      if (dateFrom && dateTo) return await this.svc.getCampaignAggregation(u.orgId, dateFrom, dateTo)
      return await this.svc.listCampaigns(u.orgId)
    } catch (e: unknown) {
      const err = e as Error
      console.error('[ml-ads] campaigns erro:', err?.message)
      if (err?.stack) console.error(err.stack)
      return []
    }
  }

  @Get('reports/summary')
  async getSummary(
    @ReqUser() u: ReqUserPayload,
    @Query('from') dateFrom: string,
    @Query('to')   dateTo:   string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    try {
      return await this.svc.getSummaryReport(u.orgId, dateFrom, dateTo)
    } catch (e: unknown) {
      const err = e as Error
      console.error('[ml-ads] summary erro:', err?.message)
      if (err?.stack) console.error(err.stack)
      return EMPTY_SUMMARY
    }
  }

  @Get('reports/campaign/:id')
  async getCampaignSeries(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Query('from') dateFrom: string,
    @Query('to')   dateTo:   string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    try {
      return await this.svc.getCampaignDailySeries(u.orgId, id, dateFrom, dateTo)
    } catch (e: unknown) {
      const err = e as Error
      console.error('[ml-ads] campaign series erro:', err?.message)
      if (err?.stack) console.error(err.stack)
      return []
    }
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  async sync(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    try {
      return await this.svc.syncForOrg(u.orgId)
    } catch (e: unknown) {
      const err = e as Error
      console.error('[ml-ads] sync erro:', err?.message)
      if (err?.stack) console.error(err.stack)
      return {
        ok: false,
        advertiser_id: null,
        campaigns: 0,
        reports: 0,
        message: err?.message ?? 'Erro durante sync',
      }
    }
  }
}
