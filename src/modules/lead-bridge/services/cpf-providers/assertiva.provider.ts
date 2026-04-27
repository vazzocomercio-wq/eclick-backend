import axios from 'axios'
import { EnrichmentProvider, EnrichmentResult } from './types'

/**
 * Assertiva Soluções /v3/localize/cpf endpoint.
 * Docs: https://api.assertiva.com.br/doc
 *
 * Auth: OAuth2 client credentials → Bearer token.
 * apiKey format: "client_id:client_secret".
 * Forte em: localização, telefone e endereço atualizados, base
 * focada em recuperação de contato.
 */
export class AssertivaProvider implements EnrichmentProvider {
  readonly id = 'assertiva'

  private async getBearerToken(clientId: string, clientSecret: string): Promise<string | null> {
    try {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
      const { data } = await axios.post(
        'https://api.assertiva.com.br/oauth2/v3/token',
        'grant_type=client_credentials',
        { headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        } },
      )
      return (data?.access_token as string) ?? null
    } catch {
      return null
    }
  }

  async enrich(cpf: string, apiKey: string): Promise<EnrichmentResult> {
    try {
      if (!apiKey.includes(':')) {
        return { success: false, provider: this.id, error: 'apiKey deve ser "client_id:client_secret"' }
      }
      const [clientId, clientSecret] = apiKey.split(':')
      const token = await this.getBearerToken(clientId, clientSecret)
      if (!token) return { success: false, provider: this.id, error: 'OAuth falhou' }

      const { data } = await axios.get(
        `https://api.assertiva.com.br/v3/localize/cpf?cpf=${cpf.replace(/\D/g, '')}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )

      const r = (data?.resposta ?? data ?? {}) as Record<string, unknown>
      const telefones = Array.isArray(r.telefones) ? r.telefones as Array<{ numero?: string }> : []
      const emails    = Array.isArray(r.emails)    ? r.emails    as Array<{ email?: string }>  : []
      const enderecos = Array.isArray(r.enderecos) ? r.enderecos as Array<Record<string, unknown>> : []
      const e0 = enderecos[0]
      return {
        success:    true,
        provider:   this.id,
        name:       (r.nome as string) ?? null,
        phone:      telefones[0]?.numero ?? null,
        email:      emails[0]?.email ?? null,
        address:    e0 ? [e0.logradouro, e0.numero, e0.cidade, e0.uf].filter(Boolean).join(', ') : null,
        birth_date: ((r.dataNascimento ?? r.data_nascimento) as string)?.slice(0, 10) ?? null,
        gender:     (r.sexo as string) ?? null,
        raw_response: data ?? {},
      }
    } catch (e: unknown) {
      const err = e as { response?: { status?: number }; message?: string }
      return { success: false, provider: this.id, error: `${err?.response?.status ?? ''} ${err?.message ?? ''}`.trim() }
    }
  }
}
