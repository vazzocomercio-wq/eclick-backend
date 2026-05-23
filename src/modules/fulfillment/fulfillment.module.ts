import { Module } from '@nestjs/common'
import { FulfillmentController } from './fulfillment.controller'
import { FulfillmentService } from './fulfillment.service'
import { FulfillmentAiService } from './fulfillment-ai.service'
import { FulfillmentLabelsService } from './fulfillment-labels.service'
import { AiModule } from '../ai/ai.module'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'

@Module({
  imports:     [AiModule, MercadolivreModule],
  controllers: [FulfillmentController],
  providers:   [FulfillmentService, FulfillmentAiService, FulfillmentLabelsService],
  exports:     [FulfillmentService],
})
export class FulfillmentModule {}
