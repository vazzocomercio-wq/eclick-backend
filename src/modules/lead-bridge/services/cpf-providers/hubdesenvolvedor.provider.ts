import axios from 'axios'
import { EnrichmentProvider, EnrichmentResult } from './types'

/**
 * Hub do Desenvolvedor /v2/cpf endpoint.
 * Docs: https://hubdodesenvolvedor.com.br/documentacao/cpf
 *
 * Auth: token passed as a URL query param (`token=...`).
 * apiKey format: single token string.
 * Forte em: barato (pay-per-query), ideal pra baixo volume e MVPs.
 */
export class HubDesenvolvedorProvider implements EnrichmentProvider {
  readonly id = 'hubdesenvolvedor'

  async enrich(cpf: string, apiKey: string): Promise<EnrichmentResult> {
    try {
      const { data } = await axios.get(
        `https://ws.hubdodesenvolvedor.com.br/v2/cpf/?cpf=${cpf.replace(/\D/g, '')}&token=${encodeURIComponent(apiKey)}`,
      )

      const r = (data?.result ?? data ?? {}) as Record<string, unknown>
      return {
        success:    true,
        provider:   this.id,
        name:       (r.nome_da_pf as string) ?? (r.nome as string) ?? null,
        phone:      (r.telefone as string) ?? null,
        email:      (r.email as string) ?? null,
        address:    null, // Hub free tier usually doesn't return address
        birth_date: ((r.data_nascimento ?? r.dataNascimento) as string)?.slice(0, 10) ?? null,
        gender:     (r.genero as string) ?? null,
        raw_response: data ?? {},
      }
    } catch (e: unknown) {
      const err = e as { response?: { status?: number }; message?: string }
      return { success: false, provider: this.id, error: `${err?.response?.status ?? ''} ${err?.message ?? ''}`.trim() }
    }
  }
}
