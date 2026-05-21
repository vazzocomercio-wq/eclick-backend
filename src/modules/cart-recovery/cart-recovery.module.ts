import { Module } from '@nestjs/common'
import { CartRecoveryService } from './cart-recovery.service'
import { CartRecoveryController, CartRecoveryPublicController } from './cart-recovery.controller'
import { ActiveBridgeModule } from '../active-bridge/active-bridge.module'

@Module({
  imports:     [ActiveBridgeModule],
  controllers: [CartRecoveryController, CartRecoveryPublicController],
  providers:   [CartRecoveryService],
  exports:     [CartRecoveryService],
})
export class CartRecoveryModule {}
