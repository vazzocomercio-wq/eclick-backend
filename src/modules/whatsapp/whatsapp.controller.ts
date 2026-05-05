import { Body, Controller, Delete, Get, Headers, HttpException, Param, Patch, Post, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import { WhatsAppConfigService } from './whatsapp-config.service'
import { WhatsAppSender } from './whatsapp.sender'

@Controller('whatsapp/config')
@UseGuards(SupabaseAuthGuard)
export class WhatsAppController {
  constructor(
    private readonly cfg:    WhatsAppConfigService,
    private readonly sender: WhatsAppSender,
  ) {}

  private async resolveUserId(auth: string | undefined): Promise<string> {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth
    const { data: { user } } = await supabaseAdmin.auth.getUser(token ?? '')
    if (!user?.id) throw new HttpException('Usuário não autenticado', 401)
    return user.id
  }

  /** Resolve orgId via 1ª org_membership do user — funciona enquanto cada
   * user tem 1 org. Quando suportarmos multi-org/user, tudo aqui passa
   * a vir do JWT (header x-org-id). */
  private async resolveOrgId(userId: string): Promise<string> {
    const { data } = await supabaseAdmin
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (!data?.organization_id) throw new HttpException('Usuário sem organização', 400)
    return data.organization_id as string
  }

  @Get()
  async getConfig(@Headers('authorization') auth: string) {
    const userId = await this.resolveUserId(auth)
    const orgId  = await this.resolveOrgId(userId)
    const config = await this.cfg.findByOrg(orgId)
    if (!config) return null
    // Strip access_token from response — it's a secret
    return { ...config, access_token: '••••' + (config.access_token?.slice(-4) ?? '') }
  }

  @Post()
  async createConfig(
    @Headers('authorization') auth: string,
    @Body() body: { phone_number_id: string; business_account_id: string; access_token: string; display_phone?: string; display_name?: string; webhook_url?: string },
  ) {
    const userId = await this.resolveUserId(auth)
    const orgId  = await this.resolveOrgId(userId)
    const config = await this.cfg.create(orgId, userId, body)
    return { ...config, access_token: '••••' + config.access_token.slice(-4) }
  }

  @Patch(':id')
  async updateConfig(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.resolveUserId(auth) // auth check (RLS handles tenant isolation)
    const config = await this.cfg.update(id, body)
    return { ...config, access_token: '••••' + (config.access_token?.slice(-4) ?? '') }
  }

  @Delete(':id')
  async removeConfig(@Headers('authorization') auth: string, @Param('id') id: string) {
    await this.resolveUserId(auth)
    await this.cfg.remove(id)
    return { ok: true }
  }

  @Post(':id/test')
  async test(@Headers('authorization') auth: string, @Param('id') id: string) {
    await this.resolveUserId(auth)
    return this.cfg.testCredentials(id)
  }

  @Get(':id/webhook-info')
  async webhookInfo(@Headers('authorization') auth: string, @Param('id') id: string) {
    const userId = await this.resolveUserId(auth)
    const orgId  = await this.resolveOrgId(userId)
    const config = await this.cfg.findByOrg(orgId)
    if (!config || config.id !== id) throw new HttpException('Config não encontrada', 404)
    return {
      webhook_url:   `${process.env.PUBLIC_BACKEND_URL ?? ''}/webhooks/whatsapp`,
      verify_token:  config.verify_token,
      is_verified:   config.is_verified,
      last_verified_at: config.last_verified_at,
    }
  }
}
