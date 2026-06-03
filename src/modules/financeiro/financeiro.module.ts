import { Module } from '@nestjs/common'
import { FinanceiroController } from './financeiro.controller'
import { FinanceiroService } from './financeiro.service'
import { OperatingCostsController } from './operating-costs.controller'
import { OperatingCostsService } from './operating-costs.service'
import { ResultDreController } from './result-dre.controller'
import { ResultDreService } from './result-dre.service'
import { ShippingRatesController } from './shipping-rates.controller'
import { ShippingRatesService } from './shipping-rates.service'
import { ChargesController } from './charges.controller'
import { MlBillingIngestService } from './ml-billing-ingest.service'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'

@Module({
  imports: [MercadolivreModule],
  controllers: [FinanceiroController, OperatingCostsController, ResultDreController, ShippingRatesController, ChargesController],
  providers: [FinanceiroService, OperatingCostsService, ResultDreService, ShippingRatesService, MlBillingIngestService],
  exports: [FinanceiroService, OperatingCostsService, ResultDreService, ShippingRatesService, MlBillingIngestService],
})
export class FinanceiroModule {}
