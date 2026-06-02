import { Module } from '@nestjs/common'
import { FinanceiroController } from './financeiro.controller'
import { FinanceiroService } from './financeiro.service'
import { OperatingCostsController } from './operating-costs.controller'
import { OperatingCostsService } from './operating-costs.service'
import { ResultDreController } from './result-dre.controller'
import { ResultDreService } from './result-dre.service'
import { ShippingRatesController } from './shipping-rates.controller'
import { ShippingRatesService } from './shipping-rates.service'

@Module({
  controllers: [FinanceiroController, OperatingCostsController, ResultDreController, ShippingRatesController],
  providers: [FinanceiroService, OperatingCostsService, ResultDreService, ShippingRatesService],
  exports: [FinanceiroService, OperatingCostsService, ResultDreService, ShippingRatesService],
})
export class FinanceiroModule {}
