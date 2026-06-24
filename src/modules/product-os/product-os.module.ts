import { Module } from '@nestjs/common'
import { ProductOsController } from './product-os.controller'
import { ProductOsService } from './product-os.service'
import { AiModule } from '../ai/ai.module'

/** Product OS — Fase 1: criação de produtos físicos (ideia → briefing IA →
 *  versões → custo). Reusa AiModule (LlmService). */
@Module({
  imports:     [AiModule],
  controllers: [ProductOsController],
  providers:   [ProductOsService],
  exports:     [ProductOsService],
})
export class ProductOsModule {}
