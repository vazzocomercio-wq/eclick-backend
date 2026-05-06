import { Module } from '@nestjs/common'
import { StoreAutomationController } from './store-automation.controller'
import { StoreAutomationService } from './store-automation.service'
import { StoreAutomationEngine } from './store-automation.engine'

/** Onda 4 / A3 — Automações Autônomas da Loja. */
@Module({
  controllers: [StoreAutomationController],
  providers:   [StoreAutomationService, StoreAutomationEngine],
  exports:     [StoreAutomationService, StoreAutomationEngine],
})
export class StoreAutomationModule {}
