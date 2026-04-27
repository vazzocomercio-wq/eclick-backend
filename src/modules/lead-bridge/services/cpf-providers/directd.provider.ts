import axios from 'axios'
import { EnrichmentProvider, EnrichmentResult } from './types'

/**
 * Direct Data /api/cpf endpoint.
 * Docs: https://docs.directd.com.br/
 *
 * Auth: token in `Authorization` header (no Bearer prefix).
 * apiKey format: single token string.
 * Forte em: 300+ fontes consolidadas, 5000+ atributos, foco em
 * compliance/KYC, telefone e endereço atualizados.
 */
export class DirectDataProvider implements EnrichmentProvider {
  readonly id = 'directd'

  async enrich(cpf: string, apiKey: string): Promise<EnrichmentResult> {
    try {
      const { data } = await axios.get(
        `https://api.directd.com.br/api/cpf?cpf=${cpf.replace(/\D/g, '')}`,
        { headers: { Authorization: apiKey } },
      )

      // DirectD returns data nested under `result` typically
      const r = (data?.result ?? data ?? {}) as Record<string, unknown>
      const phones = Array.isArray(r.phones) ? r.phones as Array<{ number?: string }> : []
      const emails = Array.isArray(r.emails) ? r.emails as Array<{ email?: string }>  : []
      const addrs  = Array.isArray(r.addresses) ? r.addresses as Array<Record<string, unknown>> : []
      const addr0  = addrs[0]
      return {
        success:    true,
        provider:   this.id,
        name:       (r.name as string) ?? null,
        phone:      phones[0]?.number ?? null,
        email:      emails[0]?.email ?? null,
        address:    addr0 ? [addr0.street, addr0.number, addr0.city, addr0.state].filter(Boolean).join(', ') : null,
        birth_date: ((r.birth_date ?? r.birthDate) as string)?.slice(0, 10) ?? null,
        gender:     (r.gender as string) ?? null,
        raw_response: data ?? {},
      }
    } catch (e: unknown) {
      const err = e as { response?: { status?: number }; message?: string }
      return { success: false, provider: this.id, error: `${err?.response?.status ?? ''} ${err?.message ?? ''}`.trim() }
    }
  }
}
