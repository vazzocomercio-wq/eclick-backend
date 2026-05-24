import { Module } from '@nestjs/common'
import { StorefrontVariantsService } from './storefront-variants.service'
import { StorefrontVariantsController, StorefrontVariantsPublicController } from './storefront-variants.controller'

/** Variantes de cor/acabamento — fundação do Provador IA (PV1). */
@Module({
  controllers: [StorefrontVariantsController, StorefrontVariantsPublicController],
  providers:   [StorefrontVariantsService],
  exports:     [StorefrontVariantsService],
})
export class StorefrontVariantsModule {}
