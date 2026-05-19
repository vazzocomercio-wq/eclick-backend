import { Module } from '@nestjs/common'
import { IcarusApiClient } from './icarus-api.client'
import { IcarusIntegrationService } from './icarus-integration.service'
import { IcarusCatalogService } from './icarus-catalog.service'
import { IcarusSyncCron } from './icarus-sync.cron'
import { IcarusIntegrationController, IcarusIntegrationListController } from './icarus-integration.controller'
import { StockModule } from '../stock/stock.module'

/**
 * Conector Icarus (Pennacorp) pra ERPs de fornecedores de dropship.
 *   - Fase 1 (2026-05-14): conexão (token criptografado).
 *   - Fase 2 (2026-05-18): catálogo em staging + sincronização por seleção
 *     (casa por SKU ou cria produto) + desconto/ajuste de custo + crons de
 *     estoque (15min) e preço (1h).
 *   - Futuro: envio reverso de pedidos pro Icarus (/order/).
 */
@Module({
  imports:     [StockModule],
  providers:   [IcarusApiClient, IcarusIntegrationService, IcarusCatalogService, IcarusSyncCron],
  controllers: [IcarusIntegrationController, IcarusIntegrationListController],
  exports:     [IcarusApiClient, IcarusIntegrationService, IcarusCatalogService],
})
export class IcarusIntegrationModule {}
