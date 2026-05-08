import { Module } from '@nestjs/common'
import { DropshipController } from './dropship.controller'
import { DropshipService } from './dropship.service'

@Module({
  controllers: [DropshipController],
  providers: [DropshipService],
  exports: [DropshipService],
})
export class DropshipModule {}
