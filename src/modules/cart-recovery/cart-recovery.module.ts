import { Module } from '@nestjs/common'
import { CartRecoveryService } from './cart-recovery.service'
import { CartRecoveryController, CartRecoveryPublicController } from './cart-recovery.controller'
import { ActiveBridgeModule } from '../active-bridge/active-bridge.module'
import { CouponsModule } from '../coupons/coupons.module'

@Module({
  imports:     [ActiveBridgeModule, CouponsModule],
  controllers: [CartRecoveryController, CartRecoveryPublicController],
  providers:   [CartRecoveryService],
  exports:     [CartRecoveryService],
})
export class CartRecoveryModule {}
