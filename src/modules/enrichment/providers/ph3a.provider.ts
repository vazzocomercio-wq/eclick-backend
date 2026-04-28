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

  // VERBOSE_LOGS — controlado por env. Default true até estabilizar (TODO: remover quando estável).
  private readonly VERBOSE = (process.env.PH3A_VERBOSE_LOGS ?? 'true') !== 'false'

  constructor() {
    super()
    if (this.VERBOSE) {
      this.logger.log(`[ph3a.boot] PH3A_USER setado: ${process.env.PH3A_USER ? 'sim (' + this.maskEmail(process.env.PH3A_USER) + ')' : 'NAO'}`)
      this.logger.log(`[ph3a.boot] PH3A_PASSWORD setado: ${process.env.PH3A_PASSWORD ? 'sim (len=' + process.env.PH3A_PASSWORD.length + ')' : 'NAO'}`)
      this.logger.log(`[ph3a.boot] PH3A_API_KEY setado: ${process.env.PH3A_API_KEY ? 'sim' : 'NAO'} (não usada na auth atual)`)
      this.logger.log(`[ph3a.boot] BASE=${this.BASE} TTL=${this.TOKEN_TTL_MS}ms`)
    }
  }

  private maskEmail(e: string): string {
    const at = e.indexOf('@')
    if (at < 2) return '***'
    return e.slice(0, 2) + '***' + e.slice(at)
  }
  private maskDoc(d: string): string {
    const c = d.replace(/\D/g, '')
    if (c.length < 4) return '***'
    return c.slice(0, 3) + '***' + c.slice(-2)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private redactBody(body: any): any {
    if (!body || typeof body !== 'object') return body
    const out = JSON.parse(JSON.stringify(body))
    for (const k of ['Token', 'token', 'AccessToken', 'access_token', 'Password', 'password']) {
      if (out[k] != null) out[k] = '<redacted>'
    }
    return out
  }

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
      if (this.VERBOSE) this.logger.log(`[ph3a.login] cache HIT (expires in ${Math.round((this.tokenCache.expires_at - Date.now()) / 1000)}s)`)
      return this.tokenCache.token
    }
    const ep = this.getEmailPassword(creds)
    if (!ep) {
      this.logger.warn(`[ph3a.login] sem creds (creds.api_secret=${creds.api_secret ? 'set' : 'null'} creds.api_key=${creds.api_key ? 'set' : 'null'} env PH3A_USER=${process.env.PH3A_USER ? 'set' : 'null'} PH3A_PASSWORD=${process.env.PH3A_PASSWORD ? 'set' : 'null'})`)
      return null
    }
    if (this.VERBOSE) this.logger.log(`[ph3a.login] tentando login com email=${this.maskEmail(ep.email)} forceRefresh=${forceRefresh}`)

    let status = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let bodyData: any = null
    try {
      const res = await axios.post<{ Token?: string; token?: string; AccessToken?: string; success?: boolean; message?: string }>(
        `${this.BASE}/DataBusca/api/Account/Login`,
        { Email: ep.email, Password: ep.password },
        { timeout: 10_000, headers: { 'Content-Type': 'application/json' }, validateStatus: () => true },
      )
      status = res.status
      bodyData = res.data
      const token = bodyData?.Token ?? bodyData?.token ?? bodyData?.AccessToken ?? null
      if (this.VERBOSE) {
        this.logger.log(`[ph3a.login] status=${status} has_token=${!!token} success=${bodyData?.success ?? '?'} message="${bodyData?.message ?? ''}"`)
      }
      if (status >= 400 || !token) {
        this.logger.warn(`[ph3a.login.error] status=${status} body=${JSON.stringify(this.redactBody(bodyData)).slice(0, 500)}`)
        return null
      }
      this.tokenCache = { token, expires_at: Date.now() + this.TOKEN_TTL_MS }
      return token
    } catch (e: unknown) {
      const err = e as AxiosError<{ message?: string }>
      this.logger.error(`[ph3a.login.exception] status=${err.response?.status ?? '?'} message=${err.message} body=${JSON.stringify(this.redactBody(err.response?.data ?? null)).slice(0, 500)}`)
      return null
    }
  }

  /** POST com auto-renovação de token: tenta 1×, se 401 limpa cache e retenta. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async authPost(path: string, body: Record<string, unknown>, creds: ProviderCreds): Promise<any> {
    let token = await this.getToken(creds)
    if (!token) throw new Error('PH3A sem credenciais (PH3A_USER + PH3A_PASSWORD)')

    if (this.VERBOSE) {
      const doc = (body as { Document?: string }).Document
      this.logger.log(`[ph3a.data] consultando path=${path} doc=${doc ? this.maskDoc(doc) : '?'}`)
    }

    const doRequest = async (tk: string) => axios.post(`${this.BASE}${path}`, body, {
      timeout: 30_000,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
      validateStatus: () => true, // tratamos manualmente
    })

    let res = await doRequest(token)
    if (this.VERBOSE) {
      this.logger.log(`[ph3a.data] status=${res.status} success=${res.data?.success ?? '?'} message="${res.data?.message ?? ''}"`)
    }

    if (res.status === 401) {
      // Token expirou → renova e retenta
      if (this.VERBOSE) this.logger.log('[ph3a.data] 401 — renovando token')
      this.tokenCache = null
      token = await this.getToken(creds, true)
      if (!token) throw new Error('PH3A re-login falhou')
      res = await doRequest(token)
      if (this.VERBOSE) {
        this.logger.log(`[ph3a.data.retry] status=${res.status} success=${res.data?.success ?? '?'} message="${res.data?.message ?? ''}"`)
      }
    }

    if (res.status >= 400) {
      this.logger.error(`[ph3a.error] path=${path} status=${res.status} body=${JSON.stringify(this.redactBody(res.data)).slice(0, 800)}`)
      throw new Error(`PH3A ${res.status}: ${res.data?.message ?? 'erro'}`)
    }

    return res.data
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
      if (this.VERBOSE) {
        const topKeys = d && typeof d === 'object' ? Object.keys(d).slice(0, 10).join(',') : 'none'
        this.logger.log(`[ph3a.parse] doc=${this.maskDoc(cleaned)} top_keys=${topKeys} phones_count=${Array.isArray(d?.Phones) ? d.Phones.length : 0} emails_count=${Array.isArray(d?.Emails) ? d.Emails.length : 0} addrs_count=${Array.isArray(d?.Addresses) ? d.Addresses.length : 0}`)
      }
      if (!d || (Object.keys(d).length === 0)) {
        if (this.VERBOSE) this.logger.warn(`[ph3a.parse] response sem Data — body raw keys=${Object.keys(data ?? {}).join(',')}`)
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
