import axios from 'axios'
import { EnrichmentProvider, EnrichmentResult } from './types'

/**
 * Big Data Corc /pessoas endpoint.
 * Docs: https://docs.bigdatacorp.com.br/pessoas
 *
 * Auth: AccessToken + TokenId headers.
 * apiKey format: "AccessToken:TokenId" (single field for storage).
 * Forte em: dados sociodemográficos, score de crédito, vínculos
 * familiares e empresariais.
 */
export class BigDataCorpProvider implements EnrichmentProvider {
  readonly id = 'bigdatacorp'

  async enrich(cpf: string, apiKey: string): Promise<EnrichmentResult> {
    try {
      const [accessToken, tokenId] = apiKey.includes(':')
        ? apiKey.split(':')
        : [apiKey, process.env.BIGDATA_TOKEN_ID ?? '']
      if (!accessToken || !tokenId) {
        return { success: false, provider: this.id, error: 'AccessToken+TokenId não configurados' }
      }

      const { data } = await axios.post(
        'https://plataforma.bigdatacorp.com.br/pessoas',
        { Datasets: 'basic_data', q: `doc{${cpf.replace(/\D/g, '')}}` },
        { headers: { AccessToken: accessToken, TokenId: tokenId } },
      )

      const basic = (data?.Result?.[0]?.BasicData ?? {}) as Record<string, unknown>
      return {
        success:    true,
        provider:   this.id,
        name:       (basic.Name as string) ?? null,
        birth_date: (basic.BirthDate as string)?.slice(0, 10) ?? null,
        gender:     (basic.Gender as string) ?? null,
        raw_response: data ?? {},
      }
    } catch (e: unknown) {
      const err = e as { response?: { status?: number }; message?: string }
      return { success: false, provider: this.id, error: `${err?.response?.status ?? ''} ${err?.message ?? ''}`.trim() }
    }
  }
}
