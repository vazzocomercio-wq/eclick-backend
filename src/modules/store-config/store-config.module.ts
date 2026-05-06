import { Module } from '@nestjs/common'
import { StoreConfigController, StorePublicController } from './store-config.controller'
import { StoreConfigService } from './store-config.service'

/** Onda 4 / A6 — Store Config (white-label). */
@Module({
  controllers: [StoreConfigController, StorePublicController],
  providers:   [StoreConfigService],
  exports:     [StoreConfigService],
})
export class StoreConfigModule {}
