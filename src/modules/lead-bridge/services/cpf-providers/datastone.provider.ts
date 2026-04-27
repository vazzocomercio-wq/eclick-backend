import axios from 'axios'
import { EnrichmentProvider, EnrichmentResult } from './types'

/**
 * Data Stone /v1/cpf endpoint.
 * Docs: https://docs.datastone.com.br/
 *
 * Auth: Bearer JWT.
 * apiKey format: full Bearer token (without the "Bearer " prefix).
 * Forte em: Waterfall Enrichment — consulta cascata em múltiplas
 * fontes, especialmente forte em telefone/whatsapp atualizado.
 */
export class DataStoneProvider implements EnrichmentProvider {
  readonly id = 'datastone'

  async enrich(cpf: string, apiKey: string): Promise<EnrichmentResult> {
    try {
      const { data } = await axios.get(
        `https://api.datastone.com.br/v1/cpf/${cpf.replace(/\D/g, '')}`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      )

      const r = (data?.data ?? data ?? {}) as Record<string, unknown>
      const phones = Array.isArray(r.phones) ? r.phones as Array<Record<string, unknown>> : []
      const emails = Array.isArray(r.emails) ? r.emails as Array<{ email?: string }>     : []
      // Data Stone often returns phones in priority order — first one is the freshest
      const phone0 = phones[0]
      const phoneNumber = phone0
        ? (phone0.whatsapp ?? phone0.number ?? phone0.phone) as string | undefined
        : undefined
      return {
        success:    true,
        provider:   this.id,
        name:       (r.name as string) ?? null,
        phone:      phoneNumber ?? null,
        email:      emails[0]?.email ?? null,
        address:    (r.address as string) ?? null,
        birth_date: ((r.birth_date ?? r.dob) as string)?.slice(0, 10) ?? null,
        gender:     (r.gender as string) ?? null,
        raw_response: data ?? {},
      }
    } catch (e: unknown) {
      const err = e as { response?: { status?: number }; message?: string }
      return { success: false, provider: this.id, error: `${err?.response?.status ?? ''} ${err?.message ?? ''}`.trim() }
    }
  }
}
