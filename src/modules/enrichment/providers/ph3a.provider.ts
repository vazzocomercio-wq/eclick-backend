import axios, { AxiosError } from 'axios'
import { Injectable, Logger } from '@nestjs/common'
import {
  BaseEnrichmentProvider, EnrichmentResult, ProviderCreds, HealthCheckResult,
  EMPTY_RESULT, elapsed,
} from './base-provider'

/**
 * PH3A DataBusca — provider brasileiro full-stack (CPF/CNPJ → Pessoa,
 * telefones rankeados, e-mails validados, endereços, score de crédito).
 *
 * Auth: 2-step.
 *   1. POST /DataBusca/api/Account/Login {Email, Password} → { Token }
 *   2. POST /DataBusca/Data com header Authorization: Bearer <token>
 *
 * Endpoint principal /DataBusca/Data espera:
 *   { Document, Type, HashType, Rules: { "Phones.Limit", "Phones.Rank", ... } }
 *   Type: 0=CPF, 1=CNPJ. HashType: 0=raw document.
 *
 * Auth confirmada via reverse-engineering em 2026-04-28:
 *   - X-API-Key/Bearer/Token/etc retornam "Session expired" 401
 *   - Login com {ApiKey:"<uuid>"} → 403 "Invalid user or password"
 *   - Login só funciona com Email+Password reais (rotacionados)
 *
 * TODO: cost_per_query = 0 (plano TESTE). Atualizar para valor real
 * quando plano definitivo for contratado.
 */
@Injectable()
export class PH3AProvider extends BaseEnrichmentProvider {
  readonly code = 'ph3a'
  private readonly logger = new Logger(PH3AProvider.name)
  private readonly DEFAULT_COST_CENTS = 0 // TODO: ajustar quando plano contratado
  private readonly BASE = 'https://api.ph3a.com.br'

  // Token cache em memória (singleton via NestJS @Injectable)
  private tokenCache: { token: string; expires_at: number } | null = null
  private readonly TOKEN_TTL_MS = 50 * 60_000 // 50min — conservador (assume TTL real ~1h)

  // ── Auth helpers ────────────────────────────────────────────────────────

  /** Lê email e senha — DB creds primeiro, fallback pra env. PH3A precisa
   * de 2 secrets, então api_key=password e api_secret=email (override). */
  private getEmailPassword(creds: ProviderCreds): { email: string; password: string } | null {
    const email    = (creds.api_secret?.trim() || process.env.PH3A_USER || '').trim()
    const password = (creds.api_key?.trim()    || process.env.PH3A_PASSWORD || '').trim()
    if (!email || !password) return null
    return { email, password }
  }

  /** Faz login e cacheia token. Re-usa cache enquanto válido. */
  private async getToken(creds: ProviderCreds, forceRefresh = false): Promise<string | null> {
    if (!forceRefresh && this.tokenCache && Date.now() < this.tokenCache.expires_at) {
      return this.tokenCache.token
    }
    const ep = this.getEmailPassword(creds)
    if (!ep) return null
    try {
      const { data } = await axios.post<{ Token?: string; token?: string; AccessToken?: string }>(
        `${this.BASE}/DataBusca/api/Account/Login`,
        { Email: ep.email, Password: ep.password },
        { timeout: 10_000, headers: { 'Content-Type': 'application/json' } },
      )
      const token = data?.Token ?? data?.token ?? data?.AccessToken ?? null
      if (!token) {
        this.logger.warn('[ph3a.login] response sem token')
        return null
      }
      this.tokenCache = { token, expires_at: Date.now() + this.TOKEN_TTL_MS }
      return token
    } catch (e: unknown) {
      const err = e as AxiosError<{ message?: string }>
      this.logger.warn(`[ph3a.login] falhou status=${err.response?.status} ${err.response?.data?.message ?? err.message}`)
      return null
    }
  }

  /** POST com auto-renovação de token: tenta 1×, se 401 limpa cache e retenta. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async authPost(path: string, body: Record<string, unknown>, creds: ProviderCreds): Promise<any> {
    let token = await this.getToken(creds)
    if (!token) throw new Error('PH3A sem credenciais (PH3A_USER + PH3A_PASSWORD)')

    const doRequest = async (tk: string) => axios.post(`${this.BASE}${path}`, body, {
      timeout: 30_000,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
    })

    try {
      const { data } = await doRequest(token)
      return data
    } catch (e: unknown) {
      const err = e as AxiosError
      if (err.response?.status === 401) {
        // Token expirou → renova e tenta de novo
        this.tokenCache = null
        token = await this.getToken(creds, true)
        if (!token) throw new Error('PH3A re-login falhou')
        const { data } = await doRequest(token)
        return data
      }
      throw e
    }
  }

  // ── Health check (free — só faz login) ──────────────────────────────────

  async healthCheck(creds: ProviderCreds): Promise<HealthCheckResult> {
    const ep = this.getEmailPassword(creds)
    if (!ep) return { ok: false, message: 'PH3A_USER e PH3A_PASSWORD não configurados' }
    try {
      const token = await this.getToken(creds, true)
      return token
        ? { ok: true,  message: 'Login OK · token obtido', metadata: { email: ep.email } }
        : { ok: false, message: 'Login falhou — verifique credenciais' }
    } catch (e: unknown) {
      return { ok: false, message: `Erro: ${(e as Error)?.message ?? 'desconhecido'}` }
    }
  }

  // ── Enrichment principal ────────────────────────────────────────────────

  async enrichCPF(cpf: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    return this.enrichDocument(cpf, 0, creds)
  }

  async enrichCNPJ(cnpj: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    return this.enrichDocument(cnpj, 1, creds)
  }

  private async enrichDocument(doc: string, type: 0 | 1, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    const cleaned = doc.replace(/\D/g, '')
    if (!cleaned) return { ...EMPTY_RESULT, quality: 'error', error: 'document vazio', duration_ms: elapsed(t0) }

    try {
      const data = await this.authPost('/DataBusca/Data', {
        Document: cleaned,
        Type:     type,
        HashType: 0,
        Rules: {
          'Phones.Limit':   3,
          'Phones.History': false,
          'Phones.Rank':    90,  // só telefones de alta confiança
        },
      }, creds)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d: any = data?.Data ?? data?.data ?? data ?? {}
      if (!d || (Object.keys(d).length === 0)) {
        return { ...EMPTY_RESULT, quality: 'empty', cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0), raw_response: data }
      }

      const fullName = (d.NameBrasil ?? d.Name ?? '').toString().trim() || undefined
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const phones = ((d.Phones ?? []) as any[])
        .filter(p => (p?.Rank ?? 100) >= 90) // safety: enforce no client side too
        .slice(0, 3)
        .map(p => ({
          number: String(p.FormattedNumber ?? p.Number ?? `${p.AreaCode ?? ''}${p.Number ?? ''}`).trim(),
          is_whatsapp: !!p.IsWhatsapp,
          is_active:   !!p.IsMobile,
        }))
        .filter(p => p.number.length > 0)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const emails = ((d.Emails ?? []) as any[])
        .filter(e => e?.IsValidated)
        .slice(0, 3)
        .map(e => ({
          address:      String(e.Email ?? '').trim().toLowerCase(),
          is_valid:     true,
          is_corporate: e.Domain ? !/(gmail|hotmail|outlook|yahoo|icloud|live|terra|uol|bol|ig)\.com/.test(String(e.Domain)) : undefined,
        }))
        .filter(e => e.address.length > 0)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const addr0: any = Array.isArray(d.Addresses) && d.Addresses.length > 0 ? d.Addresses[0] : null
      const address = addr0 ? {
        cep:          String(addr0.ZipCode ?? '').replace(/\D/g, ''),
        street:       String(addr0.Street ?? ''),
        number:       String(addr0.Number ?? ''),
        complement:   addr0.Complement ? String(addr0.Complement) : undefined,
        neighborhood: String(addr0.District ?? addr0.Neighborhood ?? ''),
        city:         String(addr0.City ?? ''),
        state:        String(addr0.State ?? ''),
      } : undefined

      const score = Number(d.CreditScore?.D90 ?? d.CreditScore?.D60 ?? d.CreditScore?.D30 ?? d.CreditScore?.D00 ?? d.CreditScore?.Ranking ?? 0)
      const credit_score = Number.isFinite(score) && score > 0 ? Math.round(score) : undefined
      const risk_level: 'low' | 'medium' | 'high' | undefined =
        credit_score == null ? undefined :
        credit_score >= 700  ? 'low'    :
        credit_score >= 400  ? 'medium' : 'high'

      const gender: 'M' | 'F' | 'O' | undefined =
        d.Gender === 'M' || d.Gender === 'F' ? d.Gender : (d.Gender ? 'O' : undefined)

      const result: EnrichmentResult = {
        success: !!fullName || phones.length > 0 || emails.length > 0,
        quality: fullName && (phones.length > 0 || emails.length > 0)
          ? 'full'
          : (fullName || phones.length > 0 || emails.length > 0) ? 'partial' : 'empty',
        data: type === 0
          ? {
              full_name:    fullName,
              cpf:          cleaned,
              birth_date:   d.BirthDate ? String(d.BirthDate).slice(0, 10) : undefined,
              gender,
              mother_name:  d.Person?.MotherName ? String(d.Person.MotherName) : undefined,
              phones:       phones.length > 0 ? phones : undefined,
              emails:       emails.length > 0 ? emails : undefined,
              address,
              credit_score,
              risk_level,
            }
          : {
              cnpj:         cleaned,
              company_name: fullName,
              phones:       phones.length > 0 ? phones : undefined,
              emails:       emails.length > 0 ? emails : undefined,
              address,
            },
        raw_response: data,
        cost_cents:   this.DEFAULT_COST_CENTS, // TODO: cobrar quando plano definitivo
        duration_ms:  elapsed(t0),
      }
      return result
    } catch (e: unknown) {
      const err = e as AxiosError<{ message?: string }>
      const msg = err.response?.data?.message ?? err.message ?? 'erro'
      this.logger.warn(`[ph3a.enrich] doc=${cleaned.slice(0,3)}*** ${msg}`)
      return { ...EMPTY_RESULT, quality: 'error', error: msg, duration_ms: elapsed(t0) }
    }
  }

  // ── Stubs (PH3A é primariamente document-based) ─────────────────────────

  async enrichPhone(_phone: string, _creds: ProviderCreds): Promise<EnrichmentResult> {
    void _phone; void _creds
    return EMPTY_RESULT
  }

  async validateEmail(_email: string, _creds: ProviderCreds): Promise<EnrichmentResult> {
    void _email; void _creds
    return EMPTY_RESULT
  }

  async validateWhatsApp(_phone: string, _creds: ProviderCreds): Promise<EnrichmentResult> {
    void _phone; void _creds
    return EMPTY_RESULT
  }

  async enrichCEP(_cep: string, _creds: ProviderCreds): Promise<EnrichmentResult> {
    void _cep; void _creds
    return EMPTY_RESULT
  }
}
