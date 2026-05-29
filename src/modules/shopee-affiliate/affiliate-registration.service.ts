import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/** F18 F4.3 — Self-signup inbound de afiliado com consent LGPD.
 *
 *  Afiliado se cadastra em /sou-afiliado-shopee com opt-in EXPLÍCITO de
 *  aparecer no Matchmaker. Sem consent = não cria. Cria profile
 *  status='active' (matcheável) só porque o consent foi dado no ato.
 *
 *  Opt-out a qualquer momento → revoga (trigger força status='revoked'). */
@Injectable()
export class AffiliateRegistrationService {
  private readonly logger = new Logger(AffiliateRegistrationService.name)

  /** Cadastro inbound. consent_given DEVE ser true (gate LGPD). */
  async register(input: RegisterInput): Promise<{ id: string; status: string }> {
    if (!input.consent_given) {
      throw new BadRequestException('Consentimento obrigatório pra entrar no diretório (LGPD).')
    }
    if (!input.display_name?.trim()) {
      throw new BadRequestException('Nome obrigatório')
    }
    const niches   = sanitizeList(input.niches)
    const channels = sanitizeList(input.channels)
    if (niches.length === 0)   throw new BadRequestException('Informe ao menos 1 nicho')
    if (channels.length === 0) throw new BadRequestException('Informe ao menos 1 canal')

    const { data, error } = await supabaseAdmin
      .schema('shopee')
      .from('affiliate_profiles')
      .insert({
        organization_id: null,                  // afiliado de plataforma
        display_name:    input.display_name.trim(),
        niches,
        channels,
        reach_estimate:  Math.max(0, Math.floor(input.reach_estimate ?? 0)),
        contact_email:   input.email ?? null,
        contact_phone:   input.phone ?? null,
        whatsapp_optin:  !!input.whatsapp_optin,
        // Consent (gate exige consent_at pra status active)
        status:          'active',
        consent_at:      new Date().toISOString(),
        consent_origin:  'inbound_signup',
        consent_ip:      input.ip ?? null,
        legal_basis:     'consent',
      })
      .select('id, status')
      .single()
    if (error) {
      this.logger.error(`[affiliate.register] ${error.message}`)
      // Trigger pode rejeitar (gate) — repassa msg amigável
      if (error.message.includes('consent_at')) {
        throw new BadRequestException('Consentimento não registrado corretamente.')
      }
      throw new Error(error.message)
    }
    this.logger.log(`[affiliate.register] novo afiliado ${(data as { id: string }).id} (consent inbound)`)
    return data as { id: string; status: string }
  }

  /** Opt-out (LGPD direito de revogação). Revoga por id. */
  async optOut(id: string, reason?: string): Promise<void> {
    const { error } = await supabaseAdmin
      .schema('shopee')
      .from('affiliate_profiles')
      .update({
        opt_out_at:     new Date().toISOString(),
        opt_out_reason: reason ?? 'solicitado pelo afiliado',
        status:         'revoked',   // trigger também força, mas explícito
      })
      .eq('id', id)
    if (error) throw new Error(error.message)
  }
}

export interface RegisterInput {
  display_name:    string
  niches:          string[] | string
  channels:        string[] | string
  reach_estimate?: number
  email?:          string | null
  phone?:          string | null
  whatsapp_optin?: boolean
  consent_given:   boolean
  ip?:             string | null
}

function sanitizeList(v: string[] | string | undefined): string[] {
  if (Array.isArray(v)) return v.map(s => String(s).trim().toLowerCase()).filter(Boolean)
  if (typeof v === 'string') return v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  return []
}
