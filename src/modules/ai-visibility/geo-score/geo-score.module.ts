import { Module } from '@nestjs/common'
import { GeoScoreController } from './geo-score.controller'

@Module({
  controllers: [GeoScoreController],
})
export class GeoScoreModule {}
