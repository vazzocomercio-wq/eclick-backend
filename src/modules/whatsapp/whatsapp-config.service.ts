import { Injectable, HttpException, NotFoundException } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'

export interface WhatsAppConfig {
  id: string
  user_id: string | null
  phone_number_id: string
  business_account_id: string
  access_token: string
  verify_token: string
  display_phone: string | null
  display_name: string | null
  webhook_url: string | null
  is_active: boolean
  is_verified: boolean
  last_verified_at: string | null
  created_at: string
  updated_at: string
}

/** Synthetic config retornado quando Z-API está ativo via env. Permite
 * que callers que checam `findActive() != null` antes de mandar continuem
 * funcionando sem precisar saber do provider. WhatsAppSender ignora os
 * campos Meta e usa env vars Z-API. */
const ZAPI_SYNTHETIC_CONFIG: WhatsAppConfig = {
  id:                  'zapi',
  user_id:             null,
  phone_number_id:     'zapi',
  business_account_id: 'zapi',
  access_token:        'zapi',
  verify_token:        '',
  display_phone:       null,
  display_name:        null,
  webhook_url:         null,
  is_active:           true,
  is_verified:         true,
  last_verified_at:    null,
  created_at:          '',
  updated_at:          '',
}

@Injectable()
export class WhatsAppConfigService {
  /**
   * Retorna a config WhatsApp ativa pra uma org. Z-API via env tem
   * prioridade global (mesma config pra todas orgs — útil enquanto não
   * migramos pra schema multi-tenant em Z-API).
   *
   * Multi-tenant: orgId obrigatório quando há rows persistidas. Sem
   * orgId, retorna apenas o synthetic Z-API se env setado, senão null.
   * Callers legacy (webhooks, lead-bridge) que ainda não passam orgId
   * recebem warning silencioso via null.
   */
  async findActive(orgId?: string): Promise<WhatsAppConfig | null> {
    // Z-API tem prioridade — callers só precisam saber que está "ativo"
    if (process.env.ZAPI_INSTANCE_ID && process.env.ZAPI_TOKEN && process.env.ZAPI_CLIENT_TOKEN) {
      return ZAPI_SYNTHETIC_CONFIG
    }
    if (!orgId) return null
    const { data } = await supabaseAdmin
      .from('whatsapp_config')
      .select('*')
      .eq('organization_id', orgId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data as WhatsAppConfig) ?? null
  }

  async findByVerifyToken(token: string): Promise<WhatsAppConfig | null> {
    // Webhook lookup por verify_token — cross-org por design (Meta envia
    // verify_token e a config tem que ser achável sem org context).
    const { data } = await supabaseAdmin
      .from('whatsapp_config')
      .select('*')
      .eq('verify_token', token)
      .maybeSingle()
    return (data as WhatsAppConfig) ?? null
  }

  async findByOrg(orgId: string): Promise<WhatsAppConfig | null> {
    const { data } = await supabaseAdmin
      .from('whatsapp_config')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data as WhatsAppConfig) ?? null
  }

  /** @deprecated use findByOrg(orgId) — mantido pra compat dos controllers
   * que ainda passam userId. Retorna a 1ª config do user em qualquer org. */
  async findByUser(userId: string): Promise<WhatsAppConfig | null> {
    const { data } = await supabaseAdmin
      .from('whatsapp_config')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data as WhatsAppConfig) ?? null
  }

  async create(orgId: string, userId: string, body: {
    phone_number_id:     string
    business_account_id: string
    access_token:        string
    display_phone?:      string
    display_name?:       string
    webhook_url?:        string
  }): Promise<WhatsAppConfig> {
    if (!body.phone_number_id || !body.business_account_id || !body.access_token) {
      throw new HttpException('phone_number_id, business_account_id e access_token são obrigatórios', 400)
    }
    const { data, error } = await supabaseAdmin
      .from('whatsapp_config')
      .insert({ organization_id: orgId, user_id: userId, ...body, is_active: true })
      .select()
      .single()
    if (error) throw new HttpException(error.message, 400)
    return data as WhatsAppConfig
  }

  async update(id: string, body: Partial<WhatsAppConfig>): Promise<WhatsAppConfig> {
    const allowed: Array<keyof WhatsAppConfig> = [
      'phone_number_id', 'business_account_id', 'access_token',
      'display_phone', 'display_name', 'webhook_url',
      'is_active', 'is_verified', 'last_verified_at',
    ]
    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const k of allowed) if (body[k] !== undefined) payload[k] = body[k]

    const { data, error } = await supabaseAdmin
      .from('whatsapp_config')
      .update(payload)
      .eq('id', id)
      .select()
      .single()
    if (error) throw new HttpException(error.message, 400)
    return data as WhatsAppConfig
  }

  async remove(id: string): Promise<void> {
    const { error } = await supabaseAdmin.from('whatsapp_config').delete().eq('id', id)
    if (error) throw new HttpException(error.message, 400)
  }

  /**
   * Test the credentials by hitting Meta's "phone number" endpoint.
   * Returns { ok, display_phone_number, verified_name } on success
   * or { ok: false, error } on auth/permission failure.
   */
  async testCredentials(id: string): Promise<{ ok: boolean; display_phone_number?: string; verified_name?: string; error?: string }> {
    const cfg = await supabaseAdmin
      .from('whatsapp_config')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (!cfg.data) throw new NotFoundException('Config não encontrada')

    try {
      const { data } = await axios.get(
        `https://graph.facebook.com/v20.0/${cfg.data.phone_number_id}?fields=display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${cfg.data.access_token}` } },
      )
      return { ok: true, display_phone_number: data.display_phone_number, verified_name: data.verified_name }
    } catch (e: any) {
      const msg = e?.response?.data?.error?.message ?? e?.message ?? 'Erro desconhecido'
      return { ok: false, error: msg }
    }
  }
}
