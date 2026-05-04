import { Module } from '@nestjs/common'
import { InternalController } from './internal.controller'
import { InternalKeyGuard } from './internal-key.guard'
import { IntelligenceHubModule } from '../intelligence-hub/intelligence-hub.module'

@Module({
  imports:     [IntelligenceHubModule],
  controllers: [InternalController],
  providers:   [InternalKeyGuard],
})
export class InternalModule {}
