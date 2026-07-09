import { Module } from '@nestjs/common'
import { PaymentsService } from './payments.service'
import { PaymentsController, StorefrontOrdersAdminController } from './payments.controller'
import { InternalWaCheckoutController } from './internal-wa-checkout.controller'
import { MercadoPagoService } from './mercado-pago.service'
import { StripeService } from './stripe.service'
import { InternalKeyGuard } from '../internal/internal-key.guard'
import { CredentialsModule } from '../credentials/credentials.module'
import { CashbackModule } from '../cashback/cashback.module'
import { BonusModule } from '../bonus/bonus.module'
import { LoyaltyModule } from '../loyalty/loyalty.module'
import { StorefrontNotificationsModule } from '../storefront-notifications/storefront-notifications.module'
import { AffiliatesModule } from '../affiliates/affiliates.module'
import { CartRecoveryModule } from '../cart-recovery/cart-recovery.module'
import { FulfillmentModule } from '../fulfillment/fulfillment.module'
import { CouponsModule } from '../coupons/coupons.module'
import { MetaCapiModule } from '../meta-capi/meta-capi.module'

@Module({
  imports:     [CredentialsModule, CashbackModule, BonusModule, LoyaltyModule, StorefrontNotificationsModule, AffiliatesModule, CartRecoveryModule, FulfillmentModule, CouponsModule, MetaCapiModule],
  providers:   [PaymentsService, MercadoPagoService, StripeService, InternalKeyGuard],
  controllers: [PaymentsController, StorefrontOrdersAdminController, InternalWaCheckoutController],
  exports:     [PaymentsService],
})
export class PaymentsModule {}
