import { Body, Controller, Get, Headers, HttpException, Param, Patch, Post, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import { AiSettingsService, AiModuleSettings } from './ai-settings.service'

@Controller('ai')
@UseGuards(SupabaseAuthGuard)
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
  providers() {
    return this.svc.listAvailableProviders()
      .then(providers => ({ providers }))
  }

  // ── Module settings ───────────────────────────────────────────────────────

  @Get('settings')
  getSettings() {
    return this.svc.getSettings()
  }

  @Patch('settings')
  updateSettings(@Body() body: AiModuleSettings) {
    return this.svc.updateSettings(body)
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  @Get('templates')
  listTemplates() {
    return this.svc.listTemplates()
  }

  @Post('agents/from-template/:templateId')
  async createFromTemplate(
    @Headers('authorization') auth: string,
    @Param('templateId') templateId: string,
    @Body() overrides: { name?: string; description?: string; system_prompt?: string; model_provider?: string; model_id?: string } = {},
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.createAgentFromTemplate(templateId, orgId, overrides)
  }
}
