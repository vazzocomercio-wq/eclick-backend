import { Controller, Get, Post, Param, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common'
import { MlAdsService } from './ml-ads.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'

@Controller('ml-ads')
@UseGuards(SupabaseAuthGuard)
export class MlAdsController {
  constructor(private readonly svc: MlAdsService) {}

  @Get('advertiser')
  advertiser() {
    return this.svc.getAdvertiser()
  }

  @Get('campaigns')
  campaigns(
    @Query('from') dateFrom?: string,
    @Query('to')   dateTo?:   string,
  ) {
    if (dateFrom && dateTo) return this.svc.getCampaignAggregation(dateFrom, dateTo)
    return this.svc.listCampaigns()
  }

  @Get('reports/summary')
  summary(
    @Query('from') dateFrom: string,
    @Query('to')   dateTo:   string,
  ) {
    return this.svc.getSummaryReport(dateFrom, dateTo)
  }

  @Get('reports/campaign/:id')
  campaignSeries(
    @Param('id') id: string,
    @Query('from') dateFrom: string,
    @Query('to')   dateTo:   string,
  ) {
    return this.svc.getCampaignDailySeries(id, dateFrom, dateTo)
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  sync() {
    return this.svc.syncAll()
  }
}
