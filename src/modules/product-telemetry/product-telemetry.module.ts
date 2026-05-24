import { Module } from '@nestjs/common'
import { AiModule } from '../ai/ai.module'
import { WhatsAppModule } from '../whatsapp/whatsapp.module'
import { TelemetryController } from './controllers/telemetry.controller'
import { InsightsController } from './controllers/insights.controller'
import { EventIngestionService } from './services/event-ingestion.service'
import { SessionService } from './services/session.service'
import { RollupService } from './services/rollup.service'
import { EngagementService } from './services/engagement.service'
import { InsightsService } from './services/insights.service'
import { InsightsAiService } from './services/insights-ai.service'

@Module({
  imports:     [AiModule, WhatsAppModule],
  controllers: [TelemetryController, InsightsController],
  providers:   [
    EventIngestionService,
    SessionService,
    RollupService,
    EngagementService,
    InsightsService,
    InsightsAiService,
  ],
})
export class ProductTelemetryModule {}
