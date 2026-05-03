import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import type { CreateChannelDto } from './dto/create-channel.dto'
import type { UpdateChannelDto } from './dto/update-channel.dto'

/**
 * CRUD de canais de comunicação por organização.
 *
 * Tabela `channels` (multi-tenant). Cada row = 1 canal de WhatsApp/email/etc
 * de uma org. Para `whatsapp_free`, o worker Baileys faz polling na tabela
 * e gerencia a sessão Socket WhatsApp Web.
 *
 * Bug #5 do Active: ao criar canal whatsapp_free, FORÇAR status='pending'
 * mesmo se `credentials` vier preenchido. Frontend pode enviar lixo herdado;
 * worker é quem decide promover pra 'active' depois do pareamento real.
 */
@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name)

  async list(orgId: string) {
    const { data, error } = await supabaseAdmin
      .from('channels')
      .select('id, channel_type, name, status, phone_number, external_id, error_message, last_webhook_at, config, created_at, updated_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })

    if (error) throw new BadRequestException(error.message)
    return data ?? []
  }

  async findOne(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin
      .from('channels')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()

    if (error) throw new BadRequestException(error.message)
    if (!data) throw new NotFoundException(`Canal ${id} não encontrado`)
    return data
  }

  async create(orgId: string, dto: CreateChannelDto) {
    if (!dto.channel_type) throw new BadRequestException('channel_type obrigatório')
    if (!dto.name?.trim()) throw new BadRequestException('name obrigatório')

    // Bug #5: whatsapp_free SEMPRE pending, ignorando credentials que venham
    // do frontend. Auth real só vem via worker depois do pareamento.
    const isBaileys = dto.channel_type === 'whatsapp_free'
    const credentials = isBaileys ? {} : (dto.credentials ?? {})

    const payload = {
      organization_id: orgId,
      channel_type:    dto.channel_type,
      name:            dto.name.trim(),
      credentials,
      webhook_url:     dto.webhook_url    ?? null,
      webhook_secret:  dto.webhook_secret ?? null,
      phone_number:    dto.phone_number   ?? null,
      external_id:     dto.external_id    ?? null,
      status:          'pending',
      config:          dto.config ?? {},
    }

    const { data, error } = await supabaseAdmin
      .from('channels')
      .insert(payload)
      .select()
      .single()

    if (error) throw new BadRequestException(error.message)
    this.logger.log(`[create] org=${orgId} type=${dto.channel_type} id=${data.id}`)
    return data
  }

  async update(orgId: string, id: string, dto: UpdateChannelDto) {
    // Confirma que canal pertence à org antes de update (defesa em profundidade
    // sobre RLS — service_role bypassa RLS).
    await this.findOne(orgId, id)

    const payload: Record<string, unknown> = {}
    if (dto.name !== undefined)           payload.name           = dto.name
    if (dto.status !== undefined)         payload.status         = dto.status
    if (dto.credentials !== undefined)    payload.credentials    = dto.credentials
    if (dto.webhook_url !== undefined)    payload.webhook_url    = dto.webhook_url
    if (dto.webhook_secret !== undefined) payload.webhook_secret = dto.webhook_secret
    if (dto.phone_number !== undefined)   payload.phone_number   = dto.phone_number
    if (dto.external_id !== undefined)    payload.external_id    = dto.external_id
    if (dto.error_message !== undefined)  payload.error_message  = dto.error_message
    if (dto.config !== undefined)         payload.config         = dto.config
    payload.updated_at = new Date().toISOString()

    const { data, error } = await supabaseAdmin
      .from('channels')
      .update(payload)
      .eq('organization_id', orgId)
      .eq('id', id)
      .select()
      .single()

    if (error) throw new BadRequestException(error.message)
    return data
  }

  async remove(orgId: string, id: string) {
    await this.findOne(orgId, id)
    const { error } = await supabaseAdmin
      .from('channels')
      .delete()
      .eq('organization_id', orgId)
      .eq('id', id)
    if (error) throw new BadRequestException(error.message)
    this.logger.log(`[remove] org=${orgId} id=${id}`)
    return { ok: true }
  }
}
