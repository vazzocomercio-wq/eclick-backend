import { Module } from '@nestjs/common'
import { KitsController } from './kits.controller'
import { KitsService } from './kits.service'
import { AiModule } from '../ai/ai.module'

/** Onda 4 / A5 — Kits & Combos com geração IA. */
@Module({
  imports:     [AiModule],
  controllers: [KitsController],
  providers:   [KitsService],
  exports:     [KitsService],
})
export class KitsModule {}
