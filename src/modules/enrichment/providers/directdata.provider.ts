import axios from 'axios'
import { Injectable } from '@nestjs/common'
import { BaseEnrichmentProvider, EnrichmentResult, ProviderCreds, EMPTY_RESULT, elapsed } from './base-provider'

/**
 * Direct Data — CadastroPessoaFisica + CadastroPessoaJuridica + Email.
 * Docs: https://docs.directd.com.br
 *
 * apiKey format: single TOKEN (passed as ?TOKEN=... query param).
 * Cost: ~R$0.40/query.
 * Strength: 300+ fontes consolidadas, foco em compliance/KYC.
 */
@Injectable()
export class DirectDataProvider extends BaseEnrichmentProvider {
  readonly code = 'directdata'
  private readonly DEFAULT_COST_CENTS = 40
  private readonly BASE = 'https://apiv3.directd.com.br/api'

  private async get(path: string, params: Record<string, string>, creds: ProviderCreds) {
    if (!creds.api_key) return null
    const { data } = await axios.get(`${creds.base_url ?? this.BASE}${path}`, {
      params: { TOKEN: creds.api_key, ...params },
    })
    return data ?? null
  }

  async enrichCPF(cpf: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const data = await this.get('/CadastroPessoaFisica', { cpf: cpf.replace(/\D/g, '') }, creds)
      const r = (data?.retorno ?? data?.result ?? data ?? {}) as Record<string, unknown>
      const phones = Array.isArray(r.telefones) ? r.telefones as Array<Record<string, unknown>> : []
      const emails = Array.isArray(r.emails)    ? r.emails    as Array<Record<string, unknown>> : []
      const addr   = (r.endereco as Record<string, unknown>) ?? null
      const result: EnrichmentResult = {
        success: !!r.nome,
        quality: r.nome ? (phones.length ? 'full' : 'partial') : 'empty',
        data: {
          full_name: (r.nome as string) ?? undefined,
          cpf:       cpf.replace(/\D/g, ''),
          birth_date: ((r.dataNascimento ?? r.nascimento) as string)?.slice(0, 10),
          gender: r.sexo === 'F' ? 'F' : r.sexo === 'M' ? 'M' : undefined,
          mother_name: (r.nomeMae as string) ?? undefined,
          phones: phones.slice(0, 5).map(p => ({ number: String(p.numero ?? p.telefone ?? ''), is_active: p.ativo !== false })),
          emails: emails.slice(0, 5).map(e => ({ address: String(e.email ?? e.endereco ?? ''), is_valid: e.valido !== false })),
          address: addr ? {
            cep:          String(addr.cep ?? '').replace(/\D/g, ''),
            street:       String(addr.logradouro ?? ''),
            number:       String(addr.numero ?? ''),
            complement:   String(addr.complemento ?? ''),
            neighborhood: String(addr.bairro ?? ''),
            city:         String(addr.cidade ?? ''),
            state:        String(addr.uf ?? ''),
          } : undefined,
        },
        raw_response: data ?? {},
        cost_cents: this.DEFAULT_COST_CENTS,
        duration_ms: elapsed(t0),
      }
      return result
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: `${e?.response?.status ?? ''} ${e?.message ?? ''}`.trim(), duration_ms: elapsed(t0) }
    }
  }

  async enrichCNPJ(cnpj: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const data = await this.get('/CadastroPessoaJuridica', { cnpj: cnpj.replace(/\D/g, '') }, creds)
      const r = (data?.retorno ?? data ?? {}) as Record<string, unknown>
      return {
        success: !!r.razaoSocial,
        quality: r.razaoSocial ? 'partial' : 'empty',
        data: {
          cnpj:         cnpj.replace(/\D/g, ''),
          company_name: (r.razaoSocial as string) ?? undefined,
          trade_name:   (r.nomeFantasia as string) ?? undefined,
          legal_status: (r.naturezaJuridica as string) ?? undefined,
        },
        raw_response: data ?? {}, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }

  async enrichPhone(phone: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const data = await this.get('/Telefone', { telefone: phone.replace(/\D/g, '') }, creds)
      const r = (data?.retorno ?? data ?? {}) as Record<string, unknown>
      return {
        success: !!r.nome,
        quality: r.nome ? 'partial' : 'empty',
        data: {
          full_name: (r.nome as string) ?? undefined,
          cpf: (r.cpf as string)?.replace(/\D/g, '') || undefined,
          phones: [{ number: phone.replace(/\D/g, ''), is_active: r.ativo !== false }],
        },
        raw_response: data ?? {}, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }

  async validateEmail(email: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const data = await this.get('/Email', { email }, creds)
      const r = (data?.retorno ?? data ?? {}) as Record<string, unknown>
      return {
        success: !!r,
        quality: 'partial',
        data: { emails: [{ address: email, is_valid: r.valido !== false, is_corporate: r.corporativo === true }] },
        raw_response: data ?? {}, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }

  async validateWhatsApp(_phone: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void _phone; return EMPTY_RESULT }

  async enrichCEP(cep: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const data = await this.get('/EnderecoPorCEP', { cep: cep.replace(/\D/g, '') }, creds)
      const r = (data?.retorno ?? data ?? {}) as Record<string, unknown>
      return {
        success: !!r.logradouro,
        quality: r.logradouro ? 'full' : 'empty',
        data: {
          address: {
            cep:          String(r.cep ?? cep).replace(/\D/g, ''),
            street:       String(r.logradouro ?? ''),
            number:       '',
            complement:   '',
            neighborhood: String(r.bairro ?? ''),
            city:         String(r.cidade ?? ''),
            state:        String(r.uf ?? ''),
          },
        },
        raw_response: data ?? {}, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }
}
