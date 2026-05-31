import { Module } from '@nestjs/common'
import { FinanceiroController } from './financeiro.controller'
import { FinanceiroService } from './financeiro.service'
import { OperatingCostsController } from './operating-costs.controller'
import { OperatingCostsService } from './operating-costs.service'

@Module({
  controllers: [FinanceiroController, OperatingCostsController],
  providers: [FinanceiroService, OperatingCostsService],
  exports: [FinanceiroService, OperatingCostsService],
})
export class FinanceiroModule {}
