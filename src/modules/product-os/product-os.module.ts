import { Module } from '@nestjs/common'
import { ProductOsController } from './product-os.controller'
import { ProductOsService } from './product-os.service'
import { ProductOsActiveService } from './product-os-active.service'
import { ProductionService } from './production.service'
import { ProductionInputService } from './production-input.service'
import { ProductPartService } from './product-part.service'
import { PrinterService } from './printer.service'
import { ProductOsCronService } from './product-os-cron.service'
import { MakeToOrderService } from './make-to-order.service'
import { SkuService } from './sku.service'
import { PaletteService } from './palette.service'
import { FarmService } from './farm.service'
import { FarmController, FarmIngestController } from './farm.controller'
import { MakerworldService } from './makerworld.service'
import { ThingiverseService } from './thingiverse.service'
import { CultsService } from './cults.service'
import { MakerworldRadarService } from './makerworld-radar.service'
import { ModelSourceRegistry } from './model-sources/model-source.registry'
import { NfeImportService } from './nfe-import.service'
import { AiModule } from '../ai/ai.module'
import { ActiveBridgeModule } from '../active-bridge/active-bridge.module'
import { ProductsModule } from '../products/products.module'
import { StockModule } from '../stock/stock.module'

/** Product OS — Fases 1-3: criação de produtos físicos (ideia → briefing IA →
 *  versões → produção → custo → anúncio). Reusa Ai/Products/Stock e o
 *  active-bridge p/ despacho operacional. */
@Module({
  imports:     [AiModule, ActiveBridgeModule, ProductsModule, StockModule],
  controllers: [ProductOsController, FarmController, FarmIngestController],
  providers:   [ProductOsService, ProductOsActiveService, ProductionService, ProductionInputService, ProductPartService, PrinterService, ProductOsCronService, MakeToOrderService, SkuService, PaletteService, FarmService, MakerworldService, ThingiverseService, CultsService, ModelSourceRegistry, MakerworldRadarService, NfeImportService],
  exports:     [ProductOsService],
})
export class ProductOsModule {}
