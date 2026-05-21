import { Module } from '@nestjs/common'
import { PaymentsService } from './payments.service'
import { PaymentsController, StorefrontOrdersAdminController } from './payments.controller'
import { MercadoPagoService } from './mercado-pago.service'
import { StripeService } from './stripe.service'
import { CredentialsModule } from '../credentials/credentials.module'
import { CashbackModule } from '../cashback/cashback.module'
import { BonusModule } from '../bonus/bonus.module'
import { LoyaltyModule } from '../loyalty/loyalty.module'
import { StorefrontNotificationsModule } from '../storefront-notifications/storefront-notifications.module'
import { AffiliatesModule } from '../affiliates/affiliates.module'
import { CartRecoveryModule } from '../cart-recovery/cart-recovery.module'

@Module({
  imports:     [CredentialsModule, CashbackModule, BonusModule, LoyaltyModule, StorefrontNotificationsModule, AffiliatesModule, CartRecoveryModule],
  providers:   [PaymentsService, MercadoPagoService, StripeService],
  controllers: [PaymentsController, StorefrontOrdersAdminController],
  exports:     [PaymentsService],
})
export class PaymentsModule {}
