import { Controller, Get, Post, Param, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common'
import { MlAdsService } from './ml-ads.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'

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
  async advertiser() {
    try {
      return await this.svc.getAdvertiser()
    } catch (e: unknown) {
      const err = e as Error
      console.error('[ml-ads] advertiser erro:', err?.message)
      if (err?.stack) console.error(err.stack)
      return null
    }
  }

  @Get('campaigns')
  async getCampaigns(
    @Query('from') dateFrom?: string,
    @Query('to')   dateTo?:   string,
  ) {
    try {
      if (dateFrom && dateTo) return await this.svc.getCampaignAggregation(dateFrom, dateTo)
      return await this.svc.listCampaigns()
    } catch (e: unknown) {
      const err = e as Error
      console.error('[ml-ads] campaigns erro:', err?.message)
      if (err?.stack) console.error(err.stack)
      return []
    }
  }

  @Get('reports/summary')
  async getSummary(
    @Query('from') dateFrom: string,
    @Query('to')   dateTo:   string,
  ) {
    try {
      return await this.svc.getSummaryReport(dateFrom, dateTo)
    } catch (e: unknown) {
      const err = e as Error
      console.error('[ml-ads] summary erro:', err?.message)
      if (err?.stack) console.error(err.stack)
      return EMPTY_SUMMARY
    }
  }

  @Get('reports/campaign/:id')
  async getCampaignSeries(
    @Param('id') id: string,
    @Query('from') dateFrom: string,
    @Query('to')   dateTo:   string,
  ) {
    try {
      return await this.svc.getCampaignDailySeries(id, dateFrom, dateTo)
    } catch (e: unknown) {
      const err = e as Error
      console.error('[ml-ads] campaign series erro:', err?.message)
      if (err?.stack) console.error(err.stack)
      return []
    }
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  async sync() {
    try {
      return await this.svc.syncAll()
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
