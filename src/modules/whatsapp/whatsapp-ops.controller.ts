import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { WhatsAppSender } from './whatsapp.sender'
import { ZapiProvider } from './zapi.provider'

/** Endpoints de operação do WhatsApp (status, teste). Separado do
 * WhatsAppController (/whatsapp/config) que cuida de CRUD do Meta legado.
 * Quando Z-API está configurado por env, esses endpoints respondem por
 * ele. Caso contrário cai no Meta cfg do banco. */
@Controller('whatsapp')
@UseGuards(SupabaseAuthGuard)
export class WhatsAppOpsController {
  constructor(
    private readonly sender: WhatsAppSender,
    private readonly zapi:   ZapiProvider,
  ) {}

  /** GET /whatsapp/status — connected/phone/battery via Z-API. */
  @Get('status')
  async status() {
    if (!this.zapi.isConfigured()) {
      return { connected: false, provider: 'none', message: 'Z-API não configurado (env vars ausentes)' }
    }
    const s = await this.zapi.getStatus()
    return {
      provider:  'zapi',
      connected: s.connected,
      phone:     s.phone ?? null,
      battery:   s.battery ?? null,
      signal:    s.signal ?? null,
    }
  }

  /** POST /whatsapp/test — envia mensagem de teste pra um número.
   * Body: { phone: "5571..." }. Útil pra validar setup de Z-API. */
  @Post('test')
  @HttpCode(HttpStatus.OK)
  async test(@Body() body: { phone?: string; message?: string }) {
    const phone = (body?.phone ?? '').trim()
    if (!phone) throw new BadRequestException('phone obrigatório')
    const message = body?.message?.trim() || '✅ e-Click — WhatsApp conectado com sucesso!'

    const r = await this.sender.sendTextMessage({ phone, message })
    return { success: r.success, messageId: r.message_id ?? null, error: r.error ?? null }
  }
}
