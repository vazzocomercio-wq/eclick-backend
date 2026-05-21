import { Module } from '@nestjs/common'
import { StorefrontEventsController } from './storefront-events.controller'
import { StorefrontEventsService } from './storefront-events.service'

@Module({
  controllers: [StorefrontEventsController],
  providers:   [StorefrontEventsService],
})
export class StorefrontEventsModule {}
