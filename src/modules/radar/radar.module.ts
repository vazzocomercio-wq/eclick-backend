import { Module } from '@nestjs/common'
import { RadarController } from './radar.controller'
import { RadarService } from './radar.service'

/**
 * e-Click Radar IA — módulo de API read-only (R4).
 * Serve as 2 telas do dashboard. A coleta vive no eclick-workers.
 */
@Module({
  controllers: [RadarController],
  providers: [RadarService],
})
export class RadarModule {}
