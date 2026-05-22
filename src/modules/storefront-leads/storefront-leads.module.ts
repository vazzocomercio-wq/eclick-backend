import { Module } from '@nestjs/common'
import { StorefrontLeadsService } from './storefront-leads.service'
import { StorefrontLeadsController, StorefrontLeadsPublicController } from './storefront-leads.controller'
import { ActiveBridgeModule } from '../active-bridge/active-bridge.module'

@Module({
  imports:     [ActiveBridgeModule],
  controllers: [StorefrontLeadsController, StorefrontLeadsPublicController],
  providers:   [StorefrontLeadsService],
  exports:     [StorefrontLeadsService],
})
export class StorefrontLeadsModule {}
