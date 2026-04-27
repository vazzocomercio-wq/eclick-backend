import axios from 'axios'
import { Injectable } from '@nestjs/common'
import { BaseEnrichmentProvider, EnrichmentResult, ProviderCreds, EMPTY_RESULT, elapsed } from './base-provider'

/**
 * ViaCEP — public Correios CEP lookup.
 * Docs: https://viacep.com.br
 *
 * Auth: none (free, no rate-limit registry but reasonable backoff
 * applies). Cost: R$0.00.
 * Use: CEP fallback, public address normalization.
 */
@Injectable()
export class ViaCepProvider extends BaseEnrichmentProvider {
  readonly code = 'viacep'

  async enrichCPF(_cpf: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void _cpf; return EMPTY_RESULT }
  async enrichCNPJ(_cnpj: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void _cnpj; return EMPTY_RESULT }
  async enrichPhone(_phone: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void _phone; return EMPTY_RESULT }
  async validateEmail(_email: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void _email; return EMPTY_RESULT }
  async validateWhatsApp(_phone: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void _phone; return EMPTY_RESULT }

  async enrichCEP(cep: string, _creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const clean = cep.replace(/\D/g, '')
      if (clean.length !== 8) {
        return { ...EMPTY_RESULT, quality: 'error', error: 'CEP deve ter 8 dígitos', duration_ms: elapsed(t0) }
      }
      const { data } = await axios.get(`https://viacep.com.br/ws/${clean}/json/`)
      if ((data as Record<string, unknown>)?.erro) {
        return { ...EMPTY_RESULT, quality: 'empty', duration_ms: elapsed(t0) }
      }
      const r = data as Record<string, unknown>
      return {
        success: true,
        quality: 'full',
        data: {
          address: {
            cep:          String(r.cep ?? clean).replace(/\D/g, ''),
            street:       String(r.logradouro ?? ''),
            number:       '',
            complement:   String(r.complemento ?? ''),
            neighborhood: String(r.bairro ?? ''),
            city:         String(r.localidade ?? ''),
            state:        String(r.uf ?? ''),
          },
        },
        raw_response: data,
        cost_cents:  0,
        duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }
}
