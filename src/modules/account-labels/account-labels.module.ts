import { Module } from '@nestjs/common'
import { AccountLabelsService } from './account-labels.service'

@Module({
  providers: [AccountLabelsService],
  exports:   [AccountLabelsService],
})
export class AccountLabelsModule {}
