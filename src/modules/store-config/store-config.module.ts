import { Module } from '@nestjs/common'
import { StoreConfigController, StorePublicController } from './store-config.controller'
import { StoreConfigService } from './store-config.service'
import { StorefrontDesignController } from './storefront-design.controller'
import { StorefrontDesignService } from './storefront-design.service'
import { AiModule } from '../ai/ai.module'
import { CanvaOauthModule } from '../canva-oauth/canva-oauth.module'

/** Onda 4 / A6 — Store Config (white-label) + Loja Propria Designer com IA. */
@Module({
  imports:     [AiModule, CanvaOauthModule],
  controllers: [StoreConfigController, StorePublicController, StorefrontDesignController],
  providers:   [StoreConfigService, StorefrontDesignService],
  exports:     [StoreConfigService],
})
export class StoreConfigModule {}
