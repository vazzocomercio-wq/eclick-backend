import { Module } from '@nestjs/common'
import { BannerGeneratorController } from './banner-generator.controller'
import { BannerGeneratorService } from './banner-generator.service'
import { AiModule } from '../ai/ai.module'

@Module({
  imports:     [AiModule],
  controllers: [BannerGeneratorController],
  providers:   [BannerGeneratorService],
  exports:     [BannerGeneratorService],
})
export class BannerGeneratorModule {}
