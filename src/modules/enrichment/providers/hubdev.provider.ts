import axios from 'axios'
import { Injectable } from '@nestjs/common'
import { BaseEnrichmentProvider, EnrichmentResult, ProviderCreds, HealthCheckResult, EMPTY_RESULT, elapsed } from './base-provider'

/**
 * Hub do Desenvolvedor — CPF / CNPJ / CEP / Email.
 * Docs: https://hubdodesenvolvedor.com.br/documentacao
 *
 * apiKey format: single token (passed as ?token=... query param).
 * Cost: ~R$0.15/query — cheapest, ideal pra baixo volume + fallback.
 */
@Injectable()
export class HubDevProvider extends BaseEnrichmentProvider {
  readonly code = 'hubdev'
  private readonly DEFAULT_COST_CENTS = 15
  private readonly BASE = 'https://ws.hubdodesenvolvedor.com.br'

  private async get(path: string, extraParams: Record<string, string>, creds: ProviderCreds) {
    if (!creds.api_key) return null
    const { data } = await axios.get(`${creds.base_url ?? this.BASE}${path}`, {
      params: { ...extraParams, token: creds.api_key },
    })
    return data ?? null
  }

  /** Hub do Desenvolvedor exposes /v2/saldo/. Free. */
  async healthCheck(creds: ProviderCreds): Promise<HealthCheckResult> {
    if (!creds.api_key) return { ok: false, message: 'Sem api_key configurada' }
    try {
      const { data } = await axios.get(`${creds.base_url ?? this.BASE}/v2/saldo/`, {
        params: { token: creds.api_key }, timeout: 8_000,
      })
      const saldo = (data?.result?.creditos ?? data?.creditos ?? null) as number | null
      return saldo != null
        ? { ok: true, message: `Conectado · ${saldo} créditos`, metadata: { creditos: saldo } }
        : { ok: true, message: 'Token aceito' }
    } catch (e: any) {
      const status = e?.response?.status
      if (status === 401 || status === 403) return { ok: false, message: 'Token inválido' }
      // 404 / outros: aceita shape como válida
      return { ok: true, message: 'Token configurado · /saldo indisponível' }
    }
  }

  async enrichCPF(cpf: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const data = await this.get('/v2/cpf/', { cpf: cpf.replace(/\D/g, '') }, creds)
      if (!data) return { ...EMPTY_RESULT, quality: 'error', error: 'sem creds', duration_ms: elapsed(t0) }
      const r = (data?.result ?? data ?? {}) as Record<string, unknown>
      return {
        success: !!(r.nome_da_pf ?? r.nome),
        quality: r.nome_da_pf || r.nome ? 'partial' : 'empty',
        data: {
          full_name: ((r.nome_da_pf ?? r.nome) as string) ?? undefined,
          cpf: cpf.replace(/\D/g, ''),
          birth_date: ((r.data_nascimento ?? r.dataNascimento) as string)?.slice(0, 10),
          gender: r.genero === 'F' ? 'F' : r.genero === 'M' ? 'M' : undefined,
        },
        raw_response: data, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }

  async enrichCNPJ(cnpj: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const data = await this.get('/v2/cnpj/', { cnpj: cnpj.replace(/\D/g, '') }, creds)
      if (!data) return { ...EMPTY_RESULT, quality: 'error', error: 'sem creds', duration_ms: elapsed(t0) }
      const r = (data?.result ?? data ?? {}) as Record<string, unknown>
      return {
        success: !!r.nome,
        quality: r.nome ? 'partial' : 'empty',
        data: {
          cnpj: cnpj.replace(/\D/g, ''),
          company_name: (r.nome as string) ?? undefined,
          trade_name:   (r.fantasia as string) ?? undefined,
          legal_status: (r.natureza_juridica as string) ?? undefined,
        },
        raw_response: data, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }

  async enrichPhone(_phone: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void _phone; return EMPTY_RESULT }

  async validateEmail(email: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const data = await this.get('/v2/validamail/', { email }, creds)
      if (!data) return { ...EMPTY_RESULT, quality: 'error', error: 'sem creds', duration_ms: elapsed(t0) }
      const r = (data?.result ?? data ?? {}) as Record<string, unknown>
      return {
        success: !!r,
        quality: 'partial',
        data: { emails: [{ address: email, is_valid: r.valido !== false }] },
        raw_response: data, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }

  async validateWhatsApp(_phone: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void _phone; return EMPTY_RESULT }

  async enrichCEP(cep: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const data = await this.get('/v2/cep/', { cep: cep.replace(/\D/g, '') }, creds)
      if (!data) return { ...EMPTY_RESULT, quality: 'error', error: 'sem creds', duration_ms: elapsed(t0) }
      const r = (data?.result ?? data ?? {}) as Record<string, unknown>
      return {
        success: !!r.logradouro,
        quality: r.logradouro ? 'full' : 'empty',
        data: {
          address: {
            cep:          cep.replace(/\D/g, ''),
            street:       String(r.logradouro ?? ''),
            number:       '',
            complement:   '',
            neighborhood: String(r.bairro ?? ''),
            city:         String(r.cidade ?? r.localidade ?? ''),
            state:        String(r.uf ?? r.estado ?? ''),
          },
        },
        raw_response: data, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }
}
