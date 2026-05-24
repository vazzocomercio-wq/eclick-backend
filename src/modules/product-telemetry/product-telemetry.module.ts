import { Module } from '@nestjs/common'
import { TelemetryController } from './controllers/telemetry.controller'
import { InsightsController } from './controllers/insights.controller'
import { EventIngestionService } from './services/event-ingestion.service'
import { SessionService } from './services/session.service'
import { RollupService } from './services/rollup.service'
import { EngagementService } from './services/engagement.service'
import { InsightsService } from './services/insights.service'

@Module({
  controllers: [TelemetryController, InsightsController],
  providers:   [
    EventIngestionService,
    SessionService,
    RollupService,
    EngagementService,
    InsightsService,
  ],
})
export class ProductTelemetryModule {}
