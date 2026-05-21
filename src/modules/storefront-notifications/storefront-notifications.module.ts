import { Module } from '@nestjs/common'
import { StorefrontNotificationsService } from './storefront-notifications.service'
import { ActiveBridgeModule } from '../active-bridge/active-bridge.module'

@Module({
  imports:   [ActiveBridgeModule],
  providers: [StorefrontNotificationsService],
  exports:   [StorefrontNotificationsService],
})
export class StorefrontNotificationsModule {}
