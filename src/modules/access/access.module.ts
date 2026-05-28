import { Module } from '@nestjs/common'
import { AccessService } from './access.service'
import { AccessPublicController, AccessAdminController } from './access.controller'

@Module({
  controllers: [AccessPublicController, AccessAdminController],
  providers:   [AccessService],
  exports:     [AccessService],
})
export class AccessModule {}
