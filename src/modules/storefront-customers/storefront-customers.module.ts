import { Module } from '@nestjs/common'
import { StorefrontCustomersController } from './storefront-customers.controller'
import { StorefrontCustomersService } from './storefront-customers.service'

@Module({
  controllers: [StorefrontCustomersController],
  providers:   [StorefrontCustomersService],
  exports:     [StorefrontCustomersService],
})
export class StorefrontCustomersModule {}
