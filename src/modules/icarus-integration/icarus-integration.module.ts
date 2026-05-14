import { Module } from '@nestjs/common'
import { IcarusApiClient } from './icarus-api.client'
import { IcarusIntegrationService } from './icarus-integration.service'
import { IcarusIntegrationController, IcarusIntegrationListController } from './icarus-integration.controller'

/**
 * Sessão 2026-05-14 — Fase 1 do conector Icarus (Pennacorp) pra ERPs de
 * fornecedores de dropship. Próximas fases:
 *   - Fase 2: sync inicial + auto-vínculo via GTIN
 *   - Fase 3: cron incremental + alertas de variação de preço/estoque
 *   - Fase 4: envio reverso de pedidos pro Icarus
 */
@Module({
  providers:   [IcarusApiClient, IcarusIntegrationService],
  controllers: [IcarusIntegrationController, IcarusIntegrationListController],
  exports:     [IcarusApiClient, IcarusIntegrationService],
})
export class IcarusIntegrationModule {}
