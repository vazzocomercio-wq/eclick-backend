import { Module } from '@nestjs/common'
import { FinanceiroController } from './financeiro.controller'
import { FinanceiroService } from './financeiro.service'
import { OperatingCostsController } from './operating-costs.controller'
import { OperatingCostsService } from './operating-costs.service'
import { ResultDreController } from './result-dre.controller'
import { ResultDreService } from './result-dre.service'

@Module({
  controllers: [FinanceiroController, OperatingCostsController, ResultDreController],
  providers: [FinanceiroService, OperatingCostsService, ResultDreService],
  exports: [FinanceiroService, OperatingCostsService, ResultDreService],
})
export class FinanceiroModule {}
