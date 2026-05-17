import { Module } from '@nestjs/common'
import { AiModule } from '../ai/ai.module'
import { RadarController } from './radar.controller'
import { RadarService } from './radar.service'
import { RadarCompetitorsController } from './radar-competitors.controller'
import { RadarCompetitorsService } from './radar-competitors.service'

/**
 * e-Click Radar IA — módulo de API.
 * R4: telas do Radar de catálogo (read-only). C3: Concorrentes Vinculados
 * (CRUD de vínculos + comparação + insight IA). A coleta vive no eclick-workers.
 */
@Module({
  imports: [AiModule],
  controllers: [RadarController, RadarCompetitorsController],
  providers: [RadarService, RadarCompetitorsService],
})
export class RadarModule {}
