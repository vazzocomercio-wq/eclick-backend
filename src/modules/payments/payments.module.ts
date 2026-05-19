import { Module } from '@nestjs/common'
import { PaymentsService } from './payments.service'
import { PaymentsController } from './payments.controller'
import { MercadoPagoService } from './mercado-pago.service'
import { StripeService } from './stripe.service'
import { CredentialsModule } from '../credentials/credentials.module'

@Module({
  imports:     [CredentialsModule],
  providers:   [PaymentsService, MercadoPagoService, StripeService],
  controllers: [PaymentsController],
  exports:     [PaymentsService],
})
export class PaymentsModule {}
