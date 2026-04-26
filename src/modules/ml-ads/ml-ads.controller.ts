import { Controller, Get, Post, Param, Query, UseGuards, HttpCode, HttpStatus, Logger } from '@nestjs/common'
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
  private readonly logger = new Logger(MlAdsController.name)

  constructor(private readonly svc: MlAdsService) {}

  // Helper — every endpoint runs the call, logs any error, and returns
  // the supplied empty fallback so the frontend never sees a 500.
  private async safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn()
    } catch (e: unknown) {
      const err = e as { message?: string; stack?: string }
      this.logger.error(`[${label}] ${err?.message}`)
      if (err?.stack) this.logger.error(err.stack)
      return fallback
    }
  }

  @Get('advertiser')
  advertiser() {
    return this.safe('advertiser', () => this.svc.getAdvertiser(), null)
  }

  @Get('campaigns')
  campaigns(
    @Query('from') dateFrom?: string,
    @Query('to')   dateTo?:   string,
  ) {
    return this.safe<unknown[]>(
      'campaigns',
      async () => dateFrom && dateTo
        ? await this.svc.getCampaignAggregation(dateFrom, dateTo)
        : await this.svc.listCampaigns(),
      [],
    )
  }

  @Get('reports/summary')
  summary(
    @Query('from') dateFrom: string,
    @Query('to')   dateTo:   string,
  ) {
    return this.safe('reports.summary', () => this.svc.getSummaryReport(dateFrom, dateTo), EMPTY_SUMMARY)
  }

  @Get('reports/campaign/:id')
  campaignSeries(
    @Param('id') id: string,
    @Query('from') dateFrom: string,
    @Query('to')   dateTo:   string,
  ) {
    return this.safe('reports.campaign', () => this.svc.getCampaignDailySeries(id, dateFrom, dateTo), [])
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  sync() {
    return this.safe(
      'sync',
      () => this.svc.syncAll(),
      { ok: false, advertiser_id: null, campaigns: 0, reports: 0, message: 'Erro durante sync — ver logs do servidor' },
    )
  }
}
