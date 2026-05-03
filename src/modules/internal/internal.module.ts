import { Module } from '@nestjs/common'
import { InternalController } from './internal.controller'
import { InternalKeyGuard } from './internal-key.guard'

@Module({
  controllers: [InternalController],
  providers:   [InternalKeyGuard],
})
export class InternalModule {}
