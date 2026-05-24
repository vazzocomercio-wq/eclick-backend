import { Module } from '@nestjs/common'
import { TelemetryController } from './controllers/telemetry.controller'
import { EventIngestionService } from './services/event-ingestion.service'
import { SessionService } from './services/session.service'

@Module({
  controllers: [TelemetryController],
  providers:   [EventIngestionService, SessionService],
})
export class ProductTelemetryModule {}
