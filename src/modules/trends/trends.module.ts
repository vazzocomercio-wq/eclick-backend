import { Module } from '@nestjs/common'
import { TrendsController } from './trends.controller'
import { TrendsService } from './trends.service'
import { TrendsCollectorService } from './trends-collector.service'
import { TrendsScoreService } from './trends-score.service'
import { TrendsWorker } from './trends.worker'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { AiModule } from '../ai/ai.module'

/** Radar de Tendências de Produtos (Fase 1 — Mercado Livre).
 *
 *  Descobre o que está em alta no mercado (busca + best sellers do ML),
 *  pontua (Trend Score determinístico) e recomenda comprar/observar/ignorar
 *  com racional IA. Platform-agnostic: Shopee entra quando a Affiliate API
 *  for liberada (novo collector plugando no mesmo schema trends_*). */
@Module({
  imports:     [MercadolivreModule, AiModule],
  controllers: [TrendsController],
  providers:   [TrendsService, TrendsCollectorService, TrendsScoreService, TrendsWorker],
  exports:     [TrendsService],
})
export class TrendsModule {}
