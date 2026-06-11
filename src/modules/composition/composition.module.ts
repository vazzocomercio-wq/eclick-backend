import { Module } from '@nestjs/common'
import { StockModule } from '../stock/stock.module'
import { CompositionService } from './composition.service'
import { CompositionController } from './composition.controller'

/** Composição (kit operacional). Depende só do StockModule (sem ciclo):
 *  a mecânica de estoque do kit vive no StockService, que lê
 *  product_components direto do banco. */
@Module({
  imports:     [StockModule],
  controllers: [CompositionController],
  providers:   [CompositionService],
  exports:     [CompositionService],
})
export class CompositionModule {}
