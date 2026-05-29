import {
  Controller, Get, Post, Patch, Delete, Param, Body, UseGuards,
  BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { ChannelsService } from './channels.service'
import { BaileysProvider } from './providers/baileys.provider'
import type { CreateChannelDto } from './dto/create-channel.dto'
import type { UpdateChannelDto } from './dto/update-channel.dto'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('channels')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ChannelsController {
  constructor(
    private readonly svc: ChannelsService,
    private readonly baileys: BaileysProvider,
  ) {}

  @Get()
  @RequirePermission('integrations.view')
  list(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.list(u.orgId)
  }

  @Get(':id')
  @RequirePermission('integrations.view')
  findOne(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.findOne(u.orgId, id)
  }

  @Post()
  @RequirePermission('integrations.connect')
  create(@ReqUser() u: ReqUserPayload, @Body() body: CreateChannelDto) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.create(u.orgId, body)
  }

  @Patch(':id')
  @RequirePermission('integrations.manage_keys')
  update(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: UpdateChannelDto,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.update(u.orgId, id, body)
  }

  @Delete(':id')
  @RequirePermission('integrations.disconnect')
  remove(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.remove(u.orgId, id)
  }

  /**
   * TEMPORÁRIO — endpoint de teste do outbound Baileys.
   * Remove após validação do Intelligence Hub estar usando o BaileysProvider em prod.
   */
  @Post(':id/test-send')
  @RequirePermission('integrations.manage_keys')
  async testSend(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { phone?: string; message?: string },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.phone?.trim())   throw new BadRequestException('phone obrigatório')
    if (!body?.message?.trim()) throw new BadRequestException('message obrigatório')

    const channel = await this.svc.findOne(u.orgId, id)
    if (channel.channel_type !== 'whatsapp_free') {
      throw new BadRequestException(`channel_type=${channel.channel_type} não suporta test-send (só whatsapp_free)`)
    }
    if (channel.status !== 'active') {
      throw new BadRequestException(`canal status=${channel.status}, precisa estar 'active'`)
    }

    // Sanitiza phone: aceita +5571..., (55)..., ou 5571... — provider espera só dígitos
    const phone = body.phone.replace(/\D/g, '')

    const result = await this.baileys.sendMessage(channel.id, phone, 'text', { body: body.message })
    return { success: true, message_id: result.message_id, channel_id: channel.id, phone }
  }

  /**
   * TEMPORÁRIO — verifica se um número tem WhatsApp ativo via Baileys.
   * Útil pra diagnosticar gestores que recebem ack de envio mas não recebem
   * a mensagem (= número errado/sem WA).
   */
  @Post(':id/check-number')
  @RequirePermission('integrations.view')
  async checkNumber(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { phone?: string },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.phone?.trim()) throw new BadRequestException('phone obrigatório')
    await this.svc.findOne(u.orgId, id)  // valida ownership
    const phone = body.phone.replace(/\D/g, '')
    const result = await this.baileys.checkNumber(u.orgId, phone)
    return { phone, ...result }
  }
}
