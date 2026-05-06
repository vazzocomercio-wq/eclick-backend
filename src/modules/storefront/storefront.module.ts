import { Module } from '@nestjs/common'
import {
  StorefrontController, StorefrontPublicController,
  CollectionsController, CollectionsPublicController,
} from './storefront.controller'
import { StorefrontService } from './storefront.service'
import { AiModule } from '../ai/ai.module'

/** Onda 4 / A2 — Vitrine personalizada + Coleções. */
@Module({
  imports:     [AiModule],
  controllers: [
    StorefrontController, StorefrontPublicController,
    CollectionsController, CollectionsPublicController,
  ],
  providers:   [StorefrontService],
  exports:     [StorefrontService],
})
export class StorefrontModule {}
