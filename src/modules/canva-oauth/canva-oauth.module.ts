import { Module } from '@nestjs/common'
import { CredentialsModule } from '../credentials/credentials.module'
import { CanvaOauthController } from './canva-oauth.controller'
import { CanvaOauthService } from './canva-oauth.service'

@Module({
  imports:     [CredentialsModule],
  controllers: [CanvaOauthController],
  providers:   [CanvaOauthService],
  exports:     [CanvaOauthService],
})
export class CanvaOauthModule {}
