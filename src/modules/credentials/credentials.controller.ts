import {
  Controller, Get, Post, Delete, Body, Param, Query,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common'
import { CredentialsService } from './credentials.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('credentials')
@UseGuards(SupabaseAuthGuard)
export class CredentialsController {
  constructor(private readonly svc: CredentialsService) {}

  // GET /credentials — list (no raw keys, only preview)
  @Get()
  list(@ReqUser() u: ReqUserPayload) {
    return this.svc.listCredentials(u.orgId)
  }

  // POST /credentials — save (and encrypt)
  @Post()
  save(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { provider: string; key_name: string; key_value: string },
  ) {
    return this.svc.saveCredential(u.orgId, u.id, body.provider, body.key_name, body.key_value)
  }

  // POST /credentials/:id/test — test connection
  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  test(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.testCredential(u.orgId, id)
  }

  // DELETE /credentials/:id
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.deleteCredential(u.orgId, id)
  }

  // GET /credentials/key?provider=anthropic — returns decrypted key (server-side use only)
  // This is intentionally only called from Next.js API routes (server-side), never from browser
  @Get('key')
  async getKey(
    @ReqUser() u: ReqUserPayload,
    @Query('provider') provider: string,
    @Query('key_name') keyName?: string,
  ) {
    const key = await this.svc.getDecryptedKey(u.orgId, provider, keyName)
    return { key }
  }
}
