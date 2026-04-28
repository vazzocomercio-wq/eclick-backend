import { Module } from '@nestjs/common'
import { CustomerHubController } from './customer-hub.controller'
import { CustomerHubService } from './customer-hub.service'
import { SegmentEvaluatorService } from './segment-evaluator.service'
import { CustomerHubCronService } from './customer-hub-cron.service'

@Module({
  controllers: [CustomerHubController],
  providers:   [CustomerHubService, SegmentEvaluatorService, CustomerHubCronService],
  exports:     [CustomerHubService, SegmentEvaluatorService],
})
export class CustomerHubModule {}
