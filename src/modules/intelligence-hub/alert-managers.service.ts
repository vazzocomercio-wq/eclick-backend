import {
  Injectable, BadRequestException, NotFoundException, Logger,
} from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { BaileysProvider } from '../channels/providers/baileys.provider'
import type { CreateManagerDto } from './dto/create-manager.dto'
import type { UpdateManagerDto } from './dto/update-manager.dto'

const VERIFICATION_TTL_MIN = 10

/**
 * CRUD de gestores que recebem alertas IA via WhatsApp.
 *
 * Fluxo de ativação:
 *   1. POST /alert-managers          → cria com status='pending', verified=false
 *   2. POST /alert-managers/:id/verify-phone   → gera código 6 dígitos + envia via Baileys
 *   3. POST /alert-managers/:id/confirm-phone  → valida → status='active', verified=true
 *
 * Phone storage: dígitos puros (sem +, espaços, parênteses) — formato Baileys.
 * Frontend pode mandar formatado, sanitizamos aqui.
 */
@Injectable()
export class AlertManagersService {
  private readonly logger = new Logger(AlertManagersService.name)

  constructor(private readonly baileys: BaileysProvider) {}

  private sanitizePhone(input: string): string {
    return input.replace(/\D/g, '')
  }

  private generateCode(): string {
    return Math.floor(100_000 + Math.random() * 900_000).toString()
  }

  private async resolveDefaultChannelId(orgId: string): Promise<string | null> {
    const { data, error } = await supabaseAdmin
      .from('channels')
      .select('id')
      .eq('organization_id', orgId)
      .eq('channel_type', 'whatsapp_free')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new BadRequestException(error.message)
    return data?.id ?? null
  }

  async list(orgId: string) {
    const { data, error } = await supabaseAdmin
      .from('alert_managers')
      .select('id, name, phone, department, role, channel_id, status, verified, preferences, stats, created_at, updated_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    if (error) throw new BadRequestException(error.message)
    return data ?? []
  }

  async findOne(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin
      .from('alert_managers')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new BadRequestException(error.message)
    if (!data) throw new NotFoundException(`Gestor ${id} não encontrado`)
    return data
  }

  async create(orgId: string, dto: CreateManagerDto) {
    if (!dto.name?.trim())       throw new BadRequestException('name obrigatório')
    if (!dto.phone?.trim())      throw new BadRequestException('phone obrigatório')
    if (!dto.department?.trim()) throw new BadRequestException('department obrigatório')

    const phone = this.sanitizePhone(dto.phone)
    if (phone.length < 10) throw new BadRequestException('phone inválido')

    const channel_id = dto.channel_id ?? (await this.resolveDefaultChannelId(orgId))

    const payload = {
      organization_id: orgId,
      name:        dto.name.trim(),
      phone,
      department:  dto.department,
      role:        dto.role ?? null,
      channel_id,
      status:      'pending',
      verified:    false,
      preferences: dto.preferences ?? {},
    }

    const { data, error } = await supabaseAdmin
      .from('alert_managers')
      .insert(payload)
      .select()
      .single()

    if (error) {
      // Conflito de unique (org+phone)
      if (error.code === '23505') {
        throw new BadRequestException('Já existe gestor com esse telefone nessa organização')
      }
      throw new BadRequestException(error.message)
    }
    this.logger.log(`[create] org=${orgId} dept=${dto.department} id=${data.id}`)
    return data
  }

  async update(orgId: string, id: string, dto: UpdateManagerDto) {
    await this.findOne(orgId, id)

    const payload: Record<string, unknown> = {}
    if (dto.name !== undefined)        payload.name        = dto.name
    if (dto.phone !== undefined)       payload.phone       = this.sanitizePhone(dto.phone)
    if (dto.department !== undefined)  payload.department  = dto.department
    if (dto.role !== undefined)        payload.role        = dto.role
    if (dto.channel_id !== undefined)  payload.channel_id  = dto.channel_id
    if (dto.status !== undefined)      payload.status      = dto.status
    if (dto.preferences !== undefined) payload.preferences = dto.preferences
    payload.updated_at = new Date().toISOString()

    const { data, error } = await supabaseAdmin
      .from('alert_managers')
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
      .from('alert_managers')
      .delete()
      .eq('organization_id', orgId)
      .eq('id', id)
    if (error) throw new BadRequestException(error.message)
    this.logger.log(`[remove] org=${orgId} id=${id}`)
    return { ok: true }
  }

  async sendVerificationCode(orgId: string, id: string) {
    const manager = await this.findOne(orgId, id)
    if (manager.verified) {
      throw new BadRequestException('Telefone já verificado')
    }

    const channelId = manager.channel_id ?? (await this.resolveDefaultChannelId(orgId))
    if (!channelId) {
      throw new BadRequestException(
        'Nenhum canal WhatsApp ativo configurado nessa organização. ' +
        'Conecte um canal WhatsApp Free em Configurações > Integrações antes de verificar gestores.',
      )
    }

    const code = this.generateCode()
    const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MIN * 60_000).toISOString()

    const { error: updErr } = await supabaseAdmin
      .from('alert_managers')
      .update({
        verification_code:       code,
        verification_expires_at: expiresAt,
        channel_id:              channelId,
        updated_at:              new Date().toISOString(),
      })
      .eq('organization_id', orgId)
      .eq('id', id)
    if (updErr) throw new BadRequestException(updErr.message)

    const message =
      `*e-Click — Código de verificação*\n\n` +
      `Olá ${manager.name}! Seu código é: *${code}*\n\n` +
      `Use esse código no painel pra confirmar que esse número receberá alertas IA do hub.\n` +
      `Válido por ${VERIFICATION_TTL_MIN} minutos.`

    try {
      await this.baileys.sendMessage(channelId, manager.phone, 'text', { body: message })
    } catch (e) {
      this.logger.error(`[verify] org=${orgId} manager=${id} envio falhou: ${(e as Error).message}`)
      throw e
    }

    this.logger.log(`[verify] org=${orgId} manager=${id} código enviado`)
    return { ok: true, expires_at: expiresAt }
  }

  async confirmPhone(orgId: string, id: string, code: string) {
    if (!code?.trim()) throw new BadRequestException('código obrigatório')
    const manager = await this.findOne(orgId, id)

    if (manager.verified) {
      return { ok: true, already_verified: true }
    }
    if (!manager.verification_code || !manager.verification_expires_at) {
      throw new BadRequestException('Nenhum código de verificação pendente. Solicite um novo.')
    }
    if (new Date(manager.verification_expires_at).getTime() < Date.now()) {
      throw new BadRequestException('Código expirado. Solicite um novo.')
    }
    if (manager.verification_code !== code.trim()) {
      throw new BadRequestException('Código incorreto')
    }

    const { data, error } = await supabaseAdmin
      .from('alert_managers')
      .update({
        verified:                true,
        status:                  'active',
        verification_code:       null,
        verification_expires_at: null,
        updated_at:              new Date().toISOString(),
      })
      .eq('organization_id', orgId)
      .eq('id', id)
      .select()
      .single()
    if (error) throw new BadRequestException(error.message)

    this.logger.log(`[verify] org=${orgId} manager=${id} confirmado`)
    return { ok: true, manager: data }
  }
}
