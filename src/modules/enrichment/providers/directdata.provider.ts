import axios from 'axios'
import { Injectable } from '@nestjs/common'
import { BaseEnrichmentProvider, EnrichmentResult, ProviderCreds, HealthCheckResult, EMPTY_RESULT, elapsed } from './base-provider'

/**
 * Direct Data — CadastroPessoaFisica + CadastroPessoaFisicaPorTelefone + Cep.
 * Docs: https://docs.directd.com.br
 *
 * Auth: TOKEN as a query-string param (NOT a header).
 * apiKey format: single TOKEN string.
 *
 * TOKEN source (probe-validated 2026-04-28):
 *   1. creds.api_key (DB — lead_bridge_configs.cpf_api_key OR
 *      enrichment_credentials.api_key)
 *   2. process.env.DIRECTDATA_TOKEN (fallback)
 *
 * Probe-validated 2026-04-28:
 *   - Base URL: apiv3.directd.com.br ✅ (api-directdata.com NÃO existe)
 *   - /CadastroPessoaFisica retorna 401 com mensagem completa
 *     "IP ou Token inválido. Verifique." → API checa IP+Token.
 *     Se 401 em produção apesar do token correto, é IP whitelist
 *     no DirectData (egress Railway precisa entrar no allowlist).
 *
 * TODO: cost_per_query = 0 (plano TESTE atual). Atualizar quando
 * plano definitivo for contratado (Vazzo confirmará valor).
 *
 * Real response shape (confirmed via live API call):
 *   {
 *     metaDados: { resultadoId: 1, resultado: "Sucesso", mensagem, ... },
 *     retorno: {
 *       cpf: "814.398.065-00",
 *       nome, sexo: "Feminino"|"Masculino",
 *       dataNascimento: "dd/MM/yyyy HH:mm:ss",
 *       nomeMae, idade,
 *       telefones: [{ telefoneComDDD, operadora, tipoTelefone, whatsApp, ... }],
 *       enderecos: [{ logradouro, numero, complemento, bairro, cidade, uf, cep }],
 *       emails:    [{ enderecoEmail }],
 *       rendaEstimada, rendaFaixaSalarial, ...
 *     }
 *   }
 */
@Injectable()
export class DirectDataProvider extends BaseEnrichmentProvider {
  readonly code = 'directdata'
  private readonly DEFAULT_COST_CENTS = 0 // TODO: ajustar quando plano contratado (era 40)
  private readonly BASE = 'https://apiv3.directd.com.br/api'

  /** Token resolution: DB creds primeiro (per-org via lead_bridge_configs
   * ou enrichment_credentials), fallback pra env do Railway. Permite
   * configurar via UI OU env-only sem mudança de código. */
  private resolveToken(creds: ProviderCreds): string | null {
    const dbToken  = creds.api_key?.trim()
    const envToken = process.env.DIRECTDATA_TOKEN?.trim()
    return dbToken || envToken || null
  }

  /** Parse "dd/MM/yyyy HH:mm:ss" → "yyyy-MM-dd". */
  private parseBR(date?: string): string | undefined {
    if (!date) return undefined
    const [day, ts] = date.split(' ')
    const parts = (day ?? date).split('/')
    if (parts.length !== 3) return undefined
    const [d, m, y] = parts
    if (!y || !m || !d) return undefined
    void ts
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  private mapGender(s?: string): 'F' | 'M' | 'O' | undefined {
    if (!s) return undefined
    const n = s.toLowerCase()
    if (n.startsWith('fem')) return 'F'
    if (n.startsWith('mas')) return 'M'
    return 'O'
  }

  /** Hit a Direct Data endpoint. Token + payload all live in the query
   * string; no body, no headers needed. Token via resolveToken (DB→env). */
  private async get(path: string, params: Record<string, string>, creds: ProviderCreds): Promise<Record<string, unknown> | null> {
    const token = this.resolveToken(creds)
    if (!token) return null
    const { data } = await axios.get(`${creds.base_url ?? this.BASE}${path}`, {
      params: { ...params, TOKEN: token },
      timeout: 15_000,
    })
    return (data ?? null) as Record<string, unknown> | null
  }

  /** Returns the `retorno` block when `metaDados.resultadoId === 1`,
   * else null. */
  private extractRetorno(body: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!body) return null
    const meta = (body.metaDados ?? body.metadados) as Record<string, unknown> | undefined
    if (meta && Number(meta.resultadoId ?? 0) !== 1) return null
    return (body.retorno ?? null) as Record<string, unknown> | null
  }

  /** Direct Data /Saldo retorna 404 hoje (probe 2026-04-28). Mantemos
   * fallback de shape: se 404, aceita; se 401/403, rejeita; senão tenta
   * ler saldo. Token resolvido via resolveToken (DB→env). */
  async healthCheck(creds: ProviderCreds): Promise<HealthCheckResult> {
    const token = this.resolveToken(creds)
    if (!token) return { ok: false, message: 'Sem token (configure DIRECTDATA_TOKEN no env ou api_key no DB)' }
    try {
      const { data } = await axios.get(`${creds.base_url ?? this.BASE}/Saldo`, {
        params: { TOKEN: token }, timeout: 8_000,
      })
      const saldo = (data?.retorno?.saldo ?? data?.saldo ?? null) as number | null
      if (saldo != null) return { ok: true, message: `Conectado · saldo R$ ${Number(saldo).toFixed(2)}`, metadata: { saldo } }
      return { ok: true, message: 'Conectado · resposta sem campo saldo' }
    } catch (e: any) {
      const status = e?.response?.status
      // 404 = /Saldo não disponível neste plano; aceita token shape
      if (status === 404) return { ok: true, message: 'Token configurado · /Saldo não disponível neste plano' }
      // 401/403 = token ou IP rejeitado; mensagem completa do API
      if (status === 401 || status === 403) {
        const apiMsg = e?.response?.data?.metaDados?.mensagem ?? 'TOKEN inválido'
        return { ok: false, message: `${apiMsg} (verifique IP whitelist do Railway no painel DirectData)` }
      }
      return { ok: false, message: e?.message ?? 'Falha na conexão' }
    }
  }

  async enrichCPF(cpf: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const body = await this.get('/CadastroPessoaFisica', { CPF: cpf.replace(/\D/g, '') }, creds)
      const r = this.extractRetorno(body)
      if (!r) return { ...EMPTY_RESULT, quality: 'empty', duration_ms: elapsed(t0) }

      const phonesRaw = Array.isArray(r.telefones) ? r.telefones as Array<Record<string, unknown>> : []
      const emailsRaw = Array.isArray(r.emails)    ? r.emails    as Array<Record<string, unknown>> : []
      const addrsRaw  = Array.isArray(r.enderecos) ? r.enderecos as Array<Record<string, unknown>> : []
      const a0 = addrsRaw[0]

      const data: EnrichmentResult['data'] = {
        full_name:  (r.nome as string) ?? undefined,
        cpf:        (r.cpf as string)?.replace(/\D/g, '') || cpf.replace(/\D/g, ''),
        birth_date: this.parseBR(r.dataNascimento as string | undefined),
        gender:     this.mapGender(r.sexo as string | undefined),
        mother_name: (r.nomeMae as string) ?? undefined,
        phones: phonesRaw.slice(0, 5).map(t => ({
          number:      String(t.telefoneComDDD ?? '').replace(/\D/g, ''),
          is_whatsapp: t.whatsApp === true,
          is_active:   t.tipoTelefone === 'TELEFONE MÓVEL',
        })),
        emails: emailsRaw.slice(0, 5).map(e => ({
          address: String(e.enderecoEmail ?? e.email ?? ''),
          is_valid: true, // Direct Data only returns valid emails
        })),
        address: a0 ? {
          cep:          String(a0.cep ?? '').replace(/\D/g, ''),
          street:       String(a0.logradouro ?? ''),
          number:       String(a0.numero ?? ''),
          complement:   String(a0.complemento ?? ''),
          neighborhood: String(a0.bairro ?? ''),
          city:         String(a0.cidade ?? ''),
          state:        String(a0.uf ?? ''),
        } : undefined,
      }

      return {
        success: true,
        quality: data.full_name && data.phones?.length ? 'full' : data.full_name ? 'partial' : 'empty',
        data,
        raw_response: body ?? {},
        cost_cents:  this.DEFAULT_COST_CENTS,
        duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: `${e?.response?.status ?? ''} ${e?.message ?? ''}`.trim(), duration_ms: elapsed(t0) }
    }
  }

  async enrichCNPJ(cnpj: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const body = await this.get('/CadastroPessoaJuridica', { CNPJ: cnpj.replace(/\D/g, '') }, creds)
      const r = this.extractRetorno(body)
      if (!r) return { ...EMPTY_RESULT, quality: 'empty', duration_ms: elapsed(t0) }
      return {
        success: !!r.razaoSocial,
        quality: r.razaoSocial ? 'partial' : 'empty',
        data: {
          cnpj:         cnpj.replace(/\D/g, ''),
          company_name: (r.razaoSocial as string) ?? undefined,
          trade_name:   (r.nomeFantasia as string) ?? undefined,
          legal_status: (r.naturezaJuridica as string) ?? undefined,
        },
        raw_response: body ?? {},
        cost_cents: this.DEFAULT_COST_CENTS,
        duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }

  /** Reverse lookup — phone → person. */
  async enrichPhone(phone: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const body = await this.get('/CadastroPessoaFisicaPorTelefone', { TELEFONE: phone.replace(/\D/g, '') }, creds)
      const r = this.extractRetorno(body)
      if (!r) return { ...EMPTY_RESULT, quality: 'empty', duration_ms: elapsed(t0) }
      const phonesRaw = Array.isArray(r.telefones) ? r.telefones as Array<Record<string, unknown>> : []
      return {
        success: !!r.nome,
        quality: r.nome ? 'partial' : 'empty',
        data: {
          full_name: (r.nome as string) ?? undefined,
          cpf: (r.cpf as string)?.replace(/\D/g, '') || undefined,
          birth_date: this.parseBR(r.dataNascimento as string | undefined),
          gender: this.mapGender(r.sexo as string | undefined),
          phones: phonesRaw.length > 0
            ? phonesRaw.slice(0, 5).map(t => ({
                number:      String(t.telefoneComDDD ?? '').replace(/\D/g, ''),
                is_whatsapp: t.whatsApp === true,
                is_active:   t.tipoTelefone === 'TELEFONE MÓVEL',
              }))
            : [{ number: phone.replace(/\D/g, ''), is_active: true }],
        },
        raw_response: body ?? {},
        cost_cents: this.DEFAULT_COST_CENTS,
        duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }

  async validateEmail(email: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const body = await this.get('/Email', { EMAIL: email }, creds)
      const r = this.extractRetorno(body) ?? {}
      return {
        success: true, quality: 'partial',
        data: { emails: [{ address: email, is_valid: r.valido !== false }] },
        raw_response: body ?? {}, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }

  async validateWhatsApp(_phone: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void _phone; return EMPTY_RESULT }

  async enrichCEP(cep: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const body = await this.get('/Cep', { CEP: cep.replace(/\D/g, '') }, creds)
      const r = this.extractRetorno(body)
      if (!r) return { ...EMPTY_RESULT, quality: 'empty', duration_ms: elapsed(t0) }
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
        raw_response: body ?? {}, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }
}
