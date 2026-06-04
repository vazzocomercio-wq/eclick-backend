import { Module } from '@nestjs/common'
import { ShippingController } from './shipping.controller'
import { ShippingService } from './shipping.service'
import { ShipmentsService } from './shipments.service'
import { ShippingProviderRegistry } from './providers/shipping-provider.registry'
import { ManualProvider } from './providers/manual.provider'

@Module({
  controllers: [ShippingController],
  providers:   [ShippingService, ShipmentsService, ShippingProviderRegistry, ManualProvider],
  exports:     [ShippingService, ShipmentsService, ShippingProviderRegistry],
})
export class ShippingModule {}
