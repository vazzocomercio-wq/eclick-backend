import {
  Controller, Get, Post, Delete, Body, Param, Query, Headers,
  UseGuards, HttpCode, HttpStatus, ForbiddenException,
} from '@nestjs/common'
import { CredentialsService } from './credentials.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('credentials')
export class CredentialsController {
  constructor(private readonly svc: CredentialsService) {}

  // GET /credentials — list (no raw keys, only preview)
  @Get()
  @UseGuards(SupabaseAuthGuard)
  list(@ReqUser() u: ReqUserPayload) {
    return this.svc.listCredentials(u.orgId)
  }

  // POST /credentials — save (and encrypt)
  @Post()
  @UseGuards(SupabaseAuthGuard)
  save(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { provider: string; key_name: string; key_value: string },
  ) {
    return this.svc.saveCredential(u.orgId, u.id, body.provider, body.key_name, body.key_value)
  }

  // POST /credentials/:id/test — test connection
  @Post(':id/test')
  @UseGuards(SupabaseAuthGuard)
  @HttpCode(HttpStatus.OK)
  test(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.testCredential(u.orgId, id)
  }

  // DELETE /credentials/:id
  @Delete(':id')
  @UseGuards(SupabaseAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.deleteCredential(u.orgId, id)
  }

  // GET /credentials/key?provider=anthropic — server-to-server only (Next.js API route)
  // Protected by x-internal header, never called from the browser
  @Get('key')
  async getKey(
    @Query('provider') provider: string,
    @Headers('x-internal') internal?: string,
  ) {
    if (internal !== 'true') throw new ForbiddenException()
    const keyName = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
    const key = await this.svc.getDecryptedKey(null, provider, keyName)
    return { key }
  }
}
