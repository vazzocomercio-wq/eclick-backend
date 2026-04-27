import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { sha256, normalizeIdentifier } from './hash.util'

@Injectable()
export class EnrichmentConsentService {
  private readonly logger = new Logger(EnrichmentConsentService.name)

  /** Returns true when the org+identifier has an active consent_enrichment.
   * For CEP we always allow (public address data, no LGPD concern). */
  async check(orgId: string, queryType: string, queryValue: string): Promise<boolean> {
    if (queryType === 'cep') return true
    try {
      const hash = sha256(normalizeIdentifier(queryType, queryValue))
      const { data } = await supabaseAdmin
        .from('enrichment_consents')
        .select('consent_enrichment, revoked_at')
        .eq('organization_id', orgId)
        .eq('identifier_hash', hash)
        .eq('identifier_type', queryType)
        .maybeSingle()
      if (!data) return false
      if (data.revoked_at) return false
      return data.consent_enrichment === true
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[enrichment.consent.check] ${err?.message}`)
      return false
    }
  }

  async record(input: {
    organization_id: string
    customer_id?:    string
    identifier:      string
    identifier_type: string
    consent_marketing?:           boolean
    consent_enrichment?:          boolean
    consent_messaging_whatsapp?:  boolean
    consent_messaging_instagram?: boolean
    consent_messaging_tiktok?:    boolean
    source?:    string
    ip?:        string
    user_agent?: string
  }) {
    const hash = sha256(normalizeIdentifier(input.identifier_type, input.identifier))
    const { data, error } = await supabaseAdmin
      .from('enrichment_consents')
      .upsert({
        organization_id: input.organization_id,
        customer_id:     input.customer_id ?? null,
        identifier_type: input.identifier_type,
        identifier_hash: hash,
        consent_marketing:            input.consent_marketing            ?? false,
        consent_enrichment:           input.consent_enrichment           ?? false,
        consent_messaging_whatsapp:   input.consent_messaging_whatsapp   ?? false,
        consent_messaging_instagram:  input.consent_messaging_instagram  ?? false,
        consent_messaging_tiktok:     input.consent_messaging_tiktok     ?? false,
        consent_source:               input.source     ?? null,
        consent_ip:                   input.ip         ?? null,
        consent_user_agent:           input.user_agent ?? null,
        consent_at:                   new Date().toISOString(),
        revoked_at: null,
      }, { onConflict: 'organization_id,identifier_hash,identifier_type' })
      .select().single()
    if (error) throw new Error(error.message)
    return data
  }

  async revoke(orgId: string, identifier: string, identifierType: string, reason?: string) {
    const hash = sha256(normalizeIdentifier(identifierType, identifier))
    const { data, error } = await supabaseAdmin
      .from('enrichment_consents')
      .update({ revoked_at: new Date().toISOString(), revoke_reason: reason ?? null })
      .eq('organization_id', orgId)
      .eq('identifier_hash', hash)
      .eq('identifier_type', identifierType)
      .select().single()
    if (error) throw new Error(error.message)
    return data
  }
}
