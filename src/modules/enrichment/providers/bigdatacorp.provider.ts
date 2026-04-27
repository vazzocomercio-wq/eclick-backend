import axios from 'axios'
import { Injectable } from '@nestjs/common'
import { BaseEnrichmentProvider, EnrichmentResult, ProviderCreds, EMPTY_RESULT, elapsed } from './base-provider'

/**
 * Big Data Corp — pessoas + empresas.
 * Docs: https://docs.bigdatacorp.com.br
 *
 * apiKey format: "AccessToken:TokenId" (split on ':' so we can store as one field)
 * Cost: ~R$0.30/query.
 * Strength: dados sociodemográficos, score de crédito, vínculos.
 */
@Injectable()
export class BigDataCorpProvider extends BaseEnrichmentProvider {
  readonly code = 'bigdatacorp'
  private readonly DEFAULT_COST_CENTS = 30

  private parseAuth(creds: ProviderCreds): { accessToken: string; tokenId: string } | null {
    const raw = creds.api_key ?? ''
    if (raw.includes(':')) {
      const [a, b] = raw.split(':')
      if (a && b) return { accessToken: a, tokenId: b }
    }
    if (creds.api_secret) return { accessToken: raw, tokenId: creds.api_secret }
    return null
  }

  private async post(datasets: string, doc: string, creds: ProviderCreds): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
    const auth = this.parseAuth(creds)
    if (!auth) return { ok: false, error: 'AccessToken+TokenId não configurados' }
    try {
      const { data } = await axios.post(
        creds.base_url ?? 'https://plataforma.bigdatacorp.com.br/pessoas',
        { Datasets: datasets, q: `doc{${doc}}` },
        { headers: { AccessToken: auth.accessToken, TokenId: auth.tokenId } },
      )
      return { ok: true, data: data ?? {} }
    } catch (e: any) {
      return { ok: false, error: `${e?.response?.status ?? ''} ${e?.message ?? ''}`.trim() }
    }
  }

  async enrichCPF(cpf: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    const r = await this.post('basic_data,phones,emails,addresses', cpf.replace(/\D/g, ''), creds)
    if (r.ok === false) return { ...EMPTY_RESULT, quality: 'error', error: r.error, duration_ms: elapsed(t0) }
    const result0 = (r.data as Record<string, unknown>)?.Result as Array<Record<string, unknown>> | undefined
    const root = result0?.[0] ?? {}
    const basic = (root.BasicData ?? {}) as Record<string, unknown>
    const phones = ((root.Phones as Record<string, unknown>)?.PhoneNumbers ?? []) as Array<Record<string, unknown>>
    const emails = ((root.Emails as Record<string, unknown>)?.EmailAddress ?? []) as Array<Record<string, unknown>>
    const addrs  = ((root.Addresses as Record<string, unknown>)?.Addresses ?? []) as Array<Record<string, unknown>>

    const a0 = addrs[0]
    const data: EnrichmentResult['data'] = {
      full_name:  (basic.Name as string) ?? undefined,
      cpf:        cpf.replace(/\D/g, ''),
      birth_date: (basic.BirthDate as string)?.slice(0, 10),
      gender:     basic.Gender === 'F' ? 'F' : basic.Gender === 'M' ? 'M' : undefined,
      mother_name: (basic.MotherName as string) ?? undefined,
      phones: phones.slice(0, 5).map(p => ({ number: String(p.Number ?? ''), is_active: p.IsActive !== false })),
      emails: emails.slice(0, 5).map(e => ({ address: String(e.EmailAddress ?? e.Address ?? ''), is_valid: e.IsValid !== false })),
      address: a0 ? {
        cep:          String(a0.ZipCode ?? a0.PostalCode ?? '').replace(/\D/g, ''),
        street:       String(a0.AddressMain ?? a0.Street ?? ''),
        number:       String(a0.Number ?? ''),
        complement:   String(a0.Complement ?? ''),
        neighborhood: String(a0.Neighborhood ?? ''),
        city:         String(a0.City ?? ''),
        state:        String(a0.State ?? ''),
      } : undefined,
    }
    const quality: EnrichmentResult['quality'] = data.full_name ? (data.phones?.length ? 'full' : 'partial') : 'empty'
    return { success: quality !== 'empty', quality, data, raw_response: r.data, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0) }
  }

  async enrichCNPJ(cnpj: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const auth = this.parseAuth(creds)
      if (!auth) return { ...EMPTY_RESULT, quality: 'error', error: 'auth não configurada', duration_ms: elapsed(t0) }
      const { data } = await axios.post(
        'https://plataforma.bigdatacorp.com.br/empresas',
        { Datasets: 'basic_data,phones,emails,addresses', q: `doc{${cnpj.replace(/\D/g, '')}}` },
        { headers: { AccessToken: auth.accessToken, TokenId: auth.tokenId } },
      )
      const root = (((data?.Result ?? []) as Array<Record<string, unknown>>)[0]) ?? {}
      const basic = (root.BasicData ?? {}) as Record<string, unknown>
      return {
        success: !!basic.OfficialName, quality: basic.OfficialName ? 'partial' : 'empty',
        data: {
          cnpj: cnpj.replace(/\D/g, ''),
          company_name: basic.OfficialName as string,
          trade_name:   (basic.TradeName as string) ?? undefined,
          legal_status: (basic.TaxRegime as string) ?? undefined,
        },
        raw_response: data, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }

  async enrichPhone(phone: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void phone; return EMPTY_RESULT }
  async validateEmail(email: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void email; return EMPTY_RESULT }
  async validateWhatsApp(phone: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void phone; return EMPTY_RESULT }
  async enrichCEP(cep: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void cep; return EMPTY_RESULT }
}
