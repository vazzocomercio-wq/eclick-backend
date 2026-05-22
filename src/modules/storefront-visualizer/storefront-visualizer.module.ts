import { Module } from '@nestjs/common'
import { StorefrontVisualizerService } from './storefront-visualizer.service'
import { StorefrontVisualizerPublicController, StorefrontVisualizerOwnerController } from './storefront-visualizer.controller'
import { ActiveBridgeModule } from '../active-bridge/active-bridge.module'
import { AiModule } from '../ai/ai.module'

@Module({
  imports:     [ActiveBridgeModule, AiModule],
  controllers: [StorefrontVisualizerPublicController, StorefrontVisualizerOwnerController],
  providers:   [StorefrontVisualizerService],
  exports:     [StorefrontVisualizerService],
})
export class StorefrontVisualizerModule {}
