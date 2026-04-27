import axios from 'axios'
import { Injectable } from '@nestjs/common'
import { BaseEnrichmentProvider, EnrichmentResult, ProviderCreds, HealthCheckResult, EMPTY_RESULT, elapsed } from './base-provider'

/**
 * Assertiva Soluções — Localize CPF/CNPJ.
 * Docs: https://api.assertiva.com.br/doc
 *
 * Auth: OAuth2 client_credentials → Bearer token (cached per call here).
 * apiKey format: "client_id:client_secret".
 * Cost: ~R$0.35/query.
 * Strength: localização, telefone e endereço atualizados.
 */
@Injectable()
export class AssertivaProvider extends BaseEnrichmentProvider {
  readonly code = 'assertiva'
  private readonly DEFAULT_COST_CENTS = 35
  private readonly BASE = 'https://api.assertiva.com.br'

  private async getToken(creds: ProviderCreds): Promise<string | null> {
    if (!creds.api_key || !creds.api_key.includes(':')) return null
    const [clientId, clientSecret] = creds.api_key.split(':')
    try {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
      const { data } = await axios.post(
        `${creds.base_url ?? this.BASE}/oauth2/v3/token`,
        'grant_type=client_credentials',
        { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' } },
      )
      return (data?.access_token as string) ?? null
    } catch { return null }
  }

  private async get(path: string, params: Record<string, string>, creds: ProviderCreds) {
    const token = await this.getToken(creds)
    if (!token) return null
    const { data } = await axios.get(`${creds.base_url ?? this.BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
    })
    return data ?? null
  }

  private map(r: Record<string, unknown>): EnrichmentResult['data'] {
    const tels  = Array.isArray(r.telefones) ? r.telefones as Array<Record<string, unknown>> : []
    const emls  = Array.isArray(r.emails)    ? r.emails    as Array<Record<string, unknown>> : []
    const ends  = Array.isArray(r.enderecos) ? r.enderecos as Array<Record<string, unknown>> : []
    const e0    = ends[0]
    return {
      full_name: (r.nome as string) ?? undefined,
      birth_date: ((r.dataNascimento ?? r.data_nascimento) as string)?.slice(0, 10),
      gender: r.sexo === 'F' ? 'F' : r.sexo === 'M' ? 'M' : undefined,
      phones: tels.slice(0, 5).map(t => ({ number: String(t.numero ?? t.telefone ?? ''), is_active: t.ativo !== false })),
      emails: emls.slice(0, 5).map(e => ({ address: String(e.email ?? ''), is_valid: e.valido !== false })),
      address: e0 ? {
        cep:          String(e0.cep ?? '').replace(/\D/g, ''),
        street:       String(e0.logradouro ?? ''),
        number:       String(e0.numero ?? ''),
        complement:   String(e0.complemento ?? ''),
        neighborhood: String(e0.bairro ?? ''),
        city:         String(e0.cidade ?? ''),
        state:        String(e0.uf ?? ''),
      } : undefined,
    }
  }

  async healthCheck(creds: ProviderCreds): Promise<HealthCheckResult> {
    if (!creds.api_key || !creds.api_key.includes(':')) {
      return { ok: false, message: 'Formato esperado: client_id:client_secret' }
    }
    const token = await this.getToken(creds)
    if (!token) return { ok: false, message: 'OAuth falhou — credenciais inválidas' }
    return { ok: true, message: 'OAuth ok · client_credentials válido' }
  }

  async enrichCPF(cpf: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const data = await this.get('/v3/localize/cpf', { cpf: cpf.replace(/\D/g, '') }, creds)
      if (!data) return { ...EMPTY_RESULT, quality: 'error', error: 'sem creds', duration_ms: elapsed(t0) }
      const r = (data?.resposta ?? data ?? {}) as Record<string, unknown>
      const mapped = this.map(r)
      return {
        success: !!mapped.full_name,
        quality: mapped.full_name ? (mapped.phones?.length ? 'full' : 'partial') : 'empty',
        data: { ...mapped, cpf: cpf.replace(/\D/g, '') },
        raw_response: data, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }

  async enrichCNPJ(cnpj: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const data = await this.get('/v3/localize/cnpj', { cnpj: cnpj.replace(/\D/g, '') }, creds)
      if (!data) return { ...EMPTY_RESULT, quality: 'error', error: 'sem creds', duration_ms: elapsed(t0) }
      const r = (data?.resposta ?? data ?? {}) as Record<string, unknown>
      return {
        success: !!r.razaoSocial,
        quality: r.razaoSocial ? 'partial' : 'empty',
        data: {
          cnpj: cnpj.replace(/\D/g, ''),
          company_name: (r.razaoSocial as string) ?? undefined,
          trade_name:   (r.nomeFantasia as string) ?? undefined,
          legal_status: (r.naturezaJuridica as string) ?? undefined,
        },
        raw_response: data, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }

  async enrichPhone(phone: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const data = await this.get('/v3/localize/telefone', { telefone: phone.replace(/\D/g, '') }, creds)
      if (!data) return { ...EMPTY_RESULT, quality: 'error', error: 'sem creds', duration_ms: elapsed(t0) }
      const r = (data?.resposta ?? data ?? {}) as Record<string, unknown>
      const mapped = this.map(r)
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
  async validateWhatsApp(_phone: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void _phone; return EMPTY_RESULT }
  async enrichCEP(_cep: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void _cep; return EMPTY_RESULT }
}
