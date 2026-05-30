import { Module } from '@nestjs/common'
import { MetaCapiService } from './meta-capi.service'
import { MetaCapiController } from './meta-capi.controller'

/**
 * Conversions API do Meta (server-side). Exporta o service pra o
 * PaymentsService disparar Purchase no pedido pago.
 */
@Module({
  providers: [MetaCapiService],
  controllers: [MetaCapiController],
  exports: [MetaCapiService],
})
export class MetaCapiModule {}
