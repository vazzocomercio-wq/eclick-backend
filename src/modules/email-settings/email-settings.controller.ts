import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus,
  Post, UseGuards,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { supabaseAdmin } from '../../common/supabase'
import { EmailSettingsService, EmailSettingsDto } from './email-settings.service'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/** REST CRUD pra /dashboard/configuracoes/integracoes — section Email.
 * Auth Bearer via SupabaseAuthGuard, org-scoped via ReqUser.orgId. Save
 * encripta api_key (AES-256-CBC) antes de gravar; test envia email real
 * pro user logado pra validar credenciais. */
@Controller('email-settings')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class EmailSettingsController {
  constructor(private readonly svc: EmailSettingsService) {}

  @Get()
  @RequirePermission('integrations.view')
  async get(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.get(user.orgId)
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('integrations.manage_keys')
  save(
    @ReqUser() user: ReqUserPayload,
    @Body() body: EmailSettingsDto,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.save(user.orgId, body)
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('integrations.manage_keys')
  remove(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.remove(user.orgId)
  }

  /** POST /email-settings/test — manda email pro usuário logado. Recipient
   * derivado do auth.users.email pra evitar spam de testes pra terceiros. */
  @Post('test')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('integrations.view')
  async test(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')

    const { data: u } = await supabaseAdmin.auth.admin.getUserById(user.id)
    const recipient = u?.user?.email
    if (!recipient) throw new BadRequestException('Email do usuário logado não encontrado')

    const r = await this.svc.test(user.orgId, recipient)
    return { ...r, recipient }
  }
}
