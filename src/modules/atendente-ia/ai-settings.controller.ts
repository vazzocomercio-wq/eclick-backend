import { Body, Controller, Get, Headers, HttpException, Param, Patch, Post, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import { AiSettingsService, AiModuleSettings } from './ai-settings.service'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

@Controller('ai')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class AiSettingsController {
  constructor(private readonly svc: AiSettingsService) {}

  private async resolveOrgId(auth: string | undefined): Promise<string> {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth
    const { data: { user } } = await supabaseAdmin.auth.getUser(token ?? '')
    const { data, error } = await supabaseAdmin
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', user?.id ?? '')
      .single()
    if (error || !data) throw new HttpException('Organização não encontrada', 400)
    return data.organization_id as string
  }

  // ── Providers (filtered by api_credentials presence) ──────────────────────

  @Get('providers/available')
  @RequirePermission('ai.view_usage')
  providers() {
    return this.svc.listAvailableProviders()
      .then(providers => ({ providers }))
  }

  // ── Module settings ───────────────────────────────────────────────────────

  @Get('settings')
  @RequirePermission('ai.view_usage')
  async getSettings(@Headers('authorization') auth: string) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getSettings(orgId)
  }

  @Patch('settings')
  @RequirePermission('ai.manage_budget')
  async updateSettings(@Headers('authorization') auth: string, @Body() body: AiModuleSettings) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.updateSettings(orgId, body)
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  @Get('templates')
  @RequirePermission('ai.view_usage')
  listTemplates() {
    return this.svc.listTemplates()
  }

  @Post('agents/from-template/:templateId')
  @RequirePermission('ai.manage_budget')
  async createFromTemplate(
    @Headers('authorization') auth: string,
    @Param('templateId') templateId: string,
    @Body() overrides: { name?: string; description?: string; system_prompt?: string; model_provider?: string; model_id?: string } = {},
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.createAgentFromTemplate(templateId, orgId, overrides)
  }
}
