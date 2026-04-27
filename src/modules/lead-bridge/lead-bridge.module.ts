import { Module } from '@nestjs/common'
import { LeadBridgeController } from './lead-bridge.controller'
import { LeadBridgePublicController } from './lead-bridge-public.controller'
import { LeadBridgeService } from './lead-bridge.service'
import { LinkGeneratorService } from './services/link-generator.service'
import { CustomersModule } from '../customers/customers.module'

@Module({
  imports:     [CustomersModule],
  controllers: [LeadBridgeController, LeadBridgePublicController],
  providers:   [LeadBridgeService, LinkGeneratorService],
  exports:     [LeadBridgeService],
})
export class LeadBridgeModule {}
