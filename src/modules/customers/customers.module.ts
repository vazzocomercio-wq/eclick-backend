import { Module } from '@nestjs/common'
import { CustomerIdentityService } from './customer-identity.service'
import { CustomersController } from './customers.controller'

@Module({
  controllers: [CustomersController],
  providers:   [CustomerIdentityService],
  exports:     [CustomerIdentityService],
})
export class CustomersModule {}
