import axios from 'axios'
import { Injectable } from '@nestjs/common'
import { BaseEnrichmentProvider, EnrichmentResult, ProviderCreds, EMPTY_RESULT, elapsed } from './base-provider'

/**
 * Data Stone — Waterfall Enrichment for phone/whatsapp + CPF.
 * Docs: https://docs.datastone.com.br
 *
 * apiKey format: full Bearer JWT (without the "Bearer " prefix).
 * Cost: ~R$0.50/query.
 * Strength: telefone/WhatsApp atualizado, cascata em múltiplas fontes.
 */
@Injectable()
export class DataStoneProvider extends BaseEnrichmentProvider {
  readonly code = 'datastone'
  private readonly DEFAULT_COST_CENTS = 50
  private readonly BASE = 'https://api.datastone.com.br/v1'

  private async get(path: string, creds: ProviderCreds): Promise<Record<string, unknown> | null> {
    if (!creds.api_key) return null
    const { data } = await axios.get(`${creds.base_url ?? this.BASE}${path}`, {
      headers: { Authorization: `Bearer ${creds.api_key}` },
    })
    return (data ?? null) as Record<string, unknown> | null
  }

  private mapBody(data: Record<string, unknown>) {
    const r = ((data?.data ?? data) ?? {}) as Record<string, unknown>
    const phones = Array.isArray(r.phones)    ? r.phones    as Array<Record<string, unknown>> : []
    const emails = Array.isArray(r.emails)    ? r.emails    as Array<{ email?: string; valid?: boolean }> : []
    return {
      full_name: (r.name as string) ?? undefined,
      cpf:       ((r.cpf as string) ?? '').replace(/\D/g, '') || undefined,
      birth_date: ((r.birth_date ?? r.dob) as string)?.slice(0, 10),
      phones: phones.slice(0, 5).map(p => ({
        number: String(p.number ?? p.phone ?? p.whatsapp ?? ''),
        is_whatsapp: Boolean(p.whatsapp),
        is_active:   p.is_active !== false,
      })),
      emails: emails.slice(0, 5).map(e => ({ address: String(e.email ?? ''), is_valid: e.valid !== false })),
      address: undefined,
    }
  }

  async enrichCPF(cpf: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const data = await this.get(`/cpf/${cpf.replace(/\D/g, '')}`, creds)
      if (!data) return { ...EMPTY_RESULT, quality: 'error', error: 'sem creds', duration_ms: elapsed(t0) }
      const mapped = this.mapBody(data)
      return {
        success: !!mapped.full_name,
        quality: mapped.full_name ? (mapped.phones?.length ? 'full' : 'partial') : 'empty',
        data: mapped, raw_response: data, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: `${e?.response?.status ?? ''} ${e?.message ?? ''}`.trim(), duration_ms: elapsed(t0) }
    }
  }

  async enrichCNPJ(_cnpj: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void _cnpj; return EMPTY_RESULT }

  async enrichPhone(phone: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const data = await this.get(`/telefone/${phone.replace(/\D/g, '')}`, creds)
      if (!data) return { ...EMPTY_RESULT, quality: 'error', error: 'sem creds', duration_ms: elapsed(t0) }
      const mapped = this.mapBody(data)
      return {
        success: !!mapped.full_name,
        quality: mapped.full_name ? 'full' : 'empty',
        data: mapped, raw_response: data, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }

  async validateEmail(_email: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void _email; return EMPTY_RESULT }

  async validateWhatsApp(phone: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    // Same endpoint as enrichPhone but signal whether the number is on WA
    const t0 = Date.now()
    try {
      const data = await this.get(`/whatsapp/${phone.replace(/\D/g, '')}`, creds)
      if (!data) return { ...EMPTY_RESULT, quality: 'error', error: 'sem creds', duration_ms: elapsed(t0) }
      const isWa = Boolean((data as Record<string, unknown>).is_whatsapp ?? (data as Record<string, unknown>).has_whatsapp)
      return {
        success: true, quality: 'partial',
        data: { phones: [{ number: phone.replace(/\D/g, ''), is_whatsapp: isWa, is_active: isWa }] },
        raw_response: data, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }

  async enrichCEP(_cep: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void _cep; return EMPTY_RESULT }
}
