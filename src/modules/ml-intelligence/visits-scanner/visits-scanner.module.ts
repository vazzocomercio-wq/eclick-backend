import { Module } from '@nestjs/common'
import { VisitsScannerService } from './visits-scanner.service'
import { VisitsScannerCron } from './visits-scanner.cron'
import { VisitsScannerController } from './visits-scanner.controller'
import { MercadolivreModule } from '../../mercadolivre/mercadolivre.module'

/**
 * F11 Fase 2 — Módulo de scanner de visitas por item.
 * Popula ml_item_visits_period via /items/{id}/visits/time_window.
 * Base pra VIEW v_leaderboard_visits_low_conv (Bloco 3.B, ainda pendente).
 */
@Module({
  imports:     [MercadolivreModule],
  controllers: [VisitsScannerController],
  providers:   [VisitsScannerService, VisitsScannerCron],
  exports:     [VisitsScannerService],
})
export class VisitsScannerModule {}
