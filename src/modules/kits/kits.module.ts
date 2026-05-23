import { Module } from '@nestjs/common'
import { KitsController } from './kits.controller'
import { KitsPublicController } from './kits.public.controller'
import { KitsService } from './kits.service'
import { AiModule } from '../ai/ai.module'

/** Onda 4 / A5 — Kits & Combos com geração IA. */
@Module({
  imports:     [AiModule],
  controllers: [KitsController, KitsPublicController],
  providers:   [KitsService],
  exports:     [KitsService],
})
export class KitsModule {}
