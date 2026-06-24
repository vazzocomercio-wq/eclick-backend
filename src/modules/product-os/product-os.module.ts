import { Module } from '@nestjs/common'
import { ProductOsController } from './product-os.controller'
import { ProductOsService } from './product-os.service'
import { ProductOsActiveService } from './product-os-active.service'
import { ProductionService } from './production.service'
import { ProductionInputService } from './production-input.service'
import { PrinterService } from './printer.service'
import { ProductOsCronService } from './product-os-cron.service'
import { AiModule } from '../ai/ai.module'
import { ActiveBridgeModule } from '../active-bridge/active-bridge.module'
import { ProductsModule } from '../products/products.module'
import { StockModule } from '../stock/stock.module'

/** Product OS — Fases 1-3: criação de produtos físicos (ideia → briefing IA →
 *  versões → produção → custo → anúncio). Reusa Ai/Products/Stock e o
 *  active-bridge p/ despacho operacional. */
@Module({
  imports:     [AiModule, ActiveBridgeModule, ProductsModule, StockModule],
  controllers: [ProductOsController],
  providers:   [ProductOsService, ProductOsActiveService, ProductionService, ProductionInputService, PrinterService, ProductOsCronService],
  exports:     [ProductOsService],
})
export class ProductOsModule {}
