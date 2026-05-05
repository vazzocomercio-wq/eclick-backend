import {
  Controller, Get, Post, Patch, Body, Query, UseGuards, HttpCode, HttpStatus,
  BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { supabaseAdmin } from '../../../common/supabase'
import { WhatsAppConfigService } from '../../whatsapp/whatsapp-config.service'
import { WhatsAppSender } from '../../whatsapp/whatsapp.sender'
import { NotificationSettingsService } from './notification-settings.service'
import { NotificationSettings } from './types'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('pricing/notifications')
@UseGuards(SupabaseAuthGuard)
export class NotificationsController {
  constructor(
    private readonly settings: NotificationSettingsService,
    private readonly waConfig: WhatsAppConfigService,
    private readonly waSender: WhatsAppSender,
  ) {}

  @Get('settings')
  getSettings(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.settings.getOrCreate(user.orgId)
  }

  @Patch('settings')
  updateSettings(
    @ReqUser() user: ReqUserPayload,
    @Body() body: Partial<NotificationSettings>,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.settings.update(user.orgId, body)
  }

  /** POST /pricing/notifications/test — envia mensagem de teste pro
   * número configurado. */
  @Post('test')
  @HttpCode(HttpStatus.OK)
  async test(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const cfg = await this.settings.getOrCreate(user.orgId)
    if (!cfg.whatsapp_phone) throw new BadRequestException('whatsapp_phone não configurado')
    const wa = await this.waConfig.findActive(user.orgId)
    if (!wa) throw new BadRequestException('WhatsApp Business não configurado no sistema')
    const message = '✅ *e-Click* — notificações WhatsApp ativadas com sucesso!\n\nEste é um teste. Você receberá alertas de preço pelos critérios configurados.'
    const result = await this.waSender.sendTextMessage({ phone: cfg.whatsapp_phone, message, waConfig: wa })
    return { ok: result.success, error: result.error ?? null }
  }

  /** GET /pricing/notifications/log?limit=50 — últimos envios. */
  @Get('log')
  async log(
    @ReqUser() user: ReqUserPayload,
    @Query('limit') limitStr?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const limit = Math.min(Math.max(Number(limitStr ?? 50), 1), 200)
    const { data, error } = await supabaseAdmin
      .from('pricing_notifications_log').select('*')
      .eq('organization_id', user.orgId)
      .order('created_at', { ascending: false }).limit(limit)
    if (error) throw new BadRequestException(error.message)
    return data ?? []
  }
}
