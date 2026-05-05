import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { WhatsAppConfigService } from '../whatsapp/whatsapp-config.service'
import type { ChannelAssignment, ResolvedChannel, WaPurpose } from './wa-router.types'

const INTERNAL_PURPOSES: WaPurpose[] = ['internal_alert', 'manager_verification']

/**
 * Resolve qual canal WhatsApp deve ser usado pra cada (org, purpose).
 *
 * Ordem de resolução:
 *   1. Lê communication_channel_assignments (assignment explícito)
 *   2. Se não há assignment, aplica fallback baseado em purpose:
 *      - internal_alert / manager_verification → Baileys (channels) primeiro,
 *        depois Meta/Z-API. Razão: comunicação interna baixo volume não
 *        precisa de provider pago.
 *      - customer_journey / customer_campaign / auth_2fa → Meta/Z-API
 *        primeiro, depois Baileys. Razão: comunicação externa precisa
 *        oficial/escala; Baileys é fallback se nada mais disponível.
 *   3. Se nenhum canal disponível, retorna null — caller decide fallback
 *      (geralmente skip + warn).
 */
@Injectable()
export class ChannelRouterService {
  private readonly logger = new Logger(ChannelRouterService.name)

  constructor(private readonly waConfig: WhatsAppConfigService) {}

  // ── Lista unificada de canais disponíveis (Baileys + Cloud) ────────────────

  async listAvailableChannels(orgId: string): Promise<Array<{
    kind:   'baileys' | 'cloud_api'
    id:     string
    name:   string
    phone:  string | null
    status: string
    detail: string | null
  }>> {
    const [baileysRes, cloudRes] = await Promise.all([
      supabaseAdmin
        .from('channels')
        .select('id, name, phone_number, status, channel_type, external_id')
        .eq('organization_id', orgId)
        .eq('channel_type', 'whatsapp_free')
        .order('created_at', { ascending: false }),
      supabaseAdmin
        .from('whatsapp_config')
        .select('id, display_name, display_phone, phone_number_id, is_active, is_verified')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false }),
    ])

    const out: Array<{ kind: 'baileys' | 'cloud_api'; id: string; name: string; phone: string | null; status: string; detail: string | null }> = []

    for (const b of (baileysRes.data ?? [])) {
      out.push({
        kind:   'baileys',
        id:     b.id as string,
        name:   (b.name as string | null) ?? (b.external_id as string | null) ?? 'WhatsApp Free',
        phone:  (b.phone_number as string | null) ?? null,
        status: (b.status as string) ?? 'unknown',
        detail: 'Baileys (gratuito, não-oficial)',
      })
    }
    for (const c of (cloudRes.data ?? [])) {
      out.push({
        kind:   'cloud_api',
        id:     c.id as string,
        name:   (c.display_name as string | null) ?? 'WhatsApp Cloud API',
        phone:  (c.display_phone as string | null) ?? null,
        status: c.is_active ? (c.is_verified ? 'verified' : 'active') : 'inactive',
        detail: 'Meta Cloud API (oficial)',
      })
    }
    return out
  }

  // ── CRUD de assignments (usado pela UI COM-3) ──────────────────────────────

  async listAssignments(orgId: string): Promise<ChannelAssignment[]> {
    const { data, error } = await supabaseAdmin
      .from('communication_channel_assignments')
      .select('*')
      .eq('organization_id', orgId)
      .order('purpose', { ascending: true })
    if (error) throw new BadRequestException(error.message)
    return (data ?? []) as ChannelAssignment[]
  }

  async upsertAssignment(orgId: string, input: {
    purpose:             WaPurpose
    baileys_channel_id?: string | null
    whatsapp_config_id?: string | null
    notes?:              string | null
  }): Promise<ChannelAssignment> {
    const baileys = input.baileys_channel_id ?? null
    const cloud   = input.whatsapp_config_id ?? null
    const xor     = (baileys != null) !== (cloud != null)
    if (!xor) {
      throw new BadRequestException('Defina exatamente um: baileys_channel_id OU whatsapp_config_id')
    }

    // Valida que o canal pertence à org
    if (baileys) {
      const { data } = await supabaseAdmin
        .from('channels').select('id')
        .eq('id', baileys).eq('organization_id', orgId).maybeSingle()
      if (!data) throw new BadRequestException('Canal Baileys não pertence à organização')
    }
    if (cloud) {
      const { data } = await supabaseAdmin
        .from('whatsapp_config').select('id')
        .eq('id', cloud).eq('organization_id', orgId).maybeSingle()
      if (!data) throw new BadRequestException('whatsapp_config não pertence à organização')
    }

    const payload = {
      organization_id:    orgId,
      purpose:            input.purpose,
      baileys_channel_id: baileys,
      whatsapp_config_id: cloud,
      notes:              input.notes ?? null,
      updated_at:         new Date().toISOString(),
    }

    const { data, error } = await supabaseAdmin
      .from('communication_channel_assignments')
      .upsert(payload, { onConflict: 'organization_id,purpose' })
      .select()
      .single()
    if (error) throw new BadRequestException(error.message)
    return data as ChannelAssignment
  }

  async deleteAssignment(orgId: string, purpose: WaPurpose): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('communication_channel_assignments')
      .delete()
      .eq('organization_id', orgId)
      .eq('purpose', purpose)
    if (error) throw new BadRequestException(error.message)
    return { ok: true }
  }

  // ── Resolver ───────────────────────────────────────────────────────────────

  async resolveChannel(orgId: string, purpose: WaPurpose): Promise<ResolvedChannel | null> {
    // 1. Lookup explícito
    const { data: assignment } = await supabaseAdmin
      .from('communication_channel_assignments')
      .select('baileys_channel_id, whatsapp_config_id')
      .eq('organization_id', orgId)
      .eq('purpose', purpose)
      .maybeSingle()

    if (assignment?.baileys_channel_id) {
      return { kind: 'baileys', channelId: assignment.baileys_channel_id as string }
    }
    if (assignment?.whatsapp_config_id) {
      return { kind: 'cloud_api', configId: assignment.whatsapp_config_id as string }
    }

    // 2. Fallback automático por purpose
    const preferBaileys = INTERNAL_PURPOSES.includes(purpose)

    const baileys   = await this.findActiveBaileys(orgId)
    const cloudCfg  = await this.waConfig.findActive(orgId)

    if (preferBaileys) {
      if (baileys)  return { kind: 'baileys',   channelId: baileys.id }
      if (cloudCfg) return { kind: 'cloud_api', configId:  cloudCfg.id }
    } else {
      if (cloudCfg) return { kind: 'cloud_api', configId:  cloudCfg.id }
      if (baileys)  return { kind: 'baileys',   channelId: baileys.id }
    }

    this.logger.warn(`[wa-router] org=${orgId} purpose=${purpose} sem canal disponível`)
    return null
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Última (canal Baileys ativo) da org. Lookup mínimo — só id+nome. */
  private async findActiveBaileys(orgId: string): Promise<{ id: string; name: string | null } | null> {
    const { data } = await supabaseAdmin
      .from('channels')
      .select('id, name')
      .eq('organization_id', orgId)
      .eq('channel_type', 'whatsapp_free')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return data ?? null
  }
}
