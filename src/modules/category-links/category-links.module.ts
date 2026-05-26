import { Module } from '@nestjs/common'
import { CategoryLinksController } from './category-links.controller'
import { CategoryLinksService } from './category-links.service'
import { AiModule } from '../ai/ai.module'

/** Cat-5 — Vínculos de categoria entre marketplaces (catálogo-produto). */
@Module({
  imports:     [AiModule],
  controllers: [CategoryLinksController],
  providers:   [CategoryLinksService],
  exports:     [CategoryLinksService],
})
export class CategoryLinksModule {}
