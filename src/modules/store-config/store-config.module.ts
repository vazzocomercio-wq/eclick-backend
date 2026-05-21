import { Module } from '@nestjs/common'
import { StoreConfigController, StorePublicController } from './store-config.controller'
import { StoreConfigService } from './store-config.service'
import { StorefrontDesignController } from './storefront-design.controller'
import { StorefrontDesignService } from './storefront-design.service'
import { StorefrontDesignV3Controller } from './storefront-design-v3.controller'
import { StorefrontDesignV3Service } from './storefront-design-v3.service'
import { AiModule } from '../ai/ai.module'
import { CanvaOauthModule } from '../canva-oauth/canva-oauth.module'
import { CredentialsModule } from '../credentials/credentials.module'

/** Onda 4 / A6 — Store Config (white-label) + Loja Propria Designer com IA + Store Builder v3. */
@Module({
  imports:     [AiModule, CanvaOauthModule, CredentialsModule],
  controllers: [StoreConfigController, StorePublicController, StorefrontDesignController, StorefrontDesignV3Controller],
  providers:   [StoreConfigService, StorefrontDesignService, StorefrontDesignV3Service],
  exports:     [StoreConfigService],
})
export class StoreConfigModule {}
