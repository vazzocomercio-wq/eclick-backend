import axios from 'axios'
import { Injectable } from '@nestjs/common'
import { BaseEnrichmentProvider, EnrichmentResult, ProviderCreds, HealthCheckResult, EMPTY_RESULT, elapsed } from './base-provider'

/**
 * Data Stone — Waterfall Enrichment for CPF/CNPJ/phone/whatsapp.
 * Docs: https://docs.datastone.com.br
 *
 * Auth: header `Authorization: Token <api_key>` (NOT Bearer).
 * apiKey format: single token string.
 * Cost: ~R$0.50/query. WhatsApp validation ~R$0.10.
 * Rate limit: 100/day default; whitelist your IP in their dashboard
 * to lift it.
 *
 * Endpoints (all under https://api.datastone.com.br/v1):
 *   GET  /persons/?cpf={cpf}                 — CPF lookup
 *   GET  /companies/?cnpj={cnpj}             — CNPJ lookup
 *   GET  /persons/search/?phone=&email=      — reverse lookup
 *   GET  /whatsapp/search/?ddd=&phone=       — WA validation (1 number)
 *   POST /whatsapp/batch/                    — WA validation (≤1000)
 *   GET  /balance                            — credits remaining (FREE)
 */
@Injectable()
export class DataStoneProvider extends BaseEnrichmentProvider {
  readonly code = 'datastone'
  private readonly DEFAULT_COST_CENTS = 50
  private readonly WHATSAPP_COST_CENTS = 10
  private readonly BASE = 'https://api.datastone.com.br/v1'

  private headers(creds: ProviderCreds): Record<string, string> {
    // Strip prefixo "Token " se vier copiado do painel da DataStone — evita
    // ficar com "Authorization: Token Token ds_..." (401 garantido).
    const k = (creds.api_key ?? '').replace(/^Token\s+/i, '')
    return { Authorization: `Token ${k}`, 'Content-Type': 'application/json' }
  }

  private async get(path: string, params: Record<string, string>, creds: ProviderCreds): Promise<Record<string, unknown> | null> {
    if (!creds.api_key) return null
    const { data } = await axios.get(`${creds.base_url ?? this.BASE}${path}`, {
      headers: this.headers(creds), params, timeout: 15_000,
    })
    return (data ?? null) as Record<string, unknown> | null
  }

  /** GET /balance — free credits probe used by Testar button. */
  async healthCheck(creds: ProviderCreds): Promise<HealthCheckResult> {
    if (!creds.api_key) return { ok: false, message: 'Sem api_key configurada' }
    try {
      const { data } = await axios.get(`${creds.base_url ?? this.BASE}/balance`, {
        headers: this.headers(creds), timeout: 10_000,
      })
      const b2c = Number(data?.b2c_credits ?? data?.b2c ?? 0)
      const b2b = Number(data?.b2b_credits ?? data?.b2b ?? 0)
      return {
        ok: true,
        message: `Conectado · ${b2c.toLocaleString('pt-BR')} créditos B2C${b2b > 0 ? ` · ${b2b.toLocaleString('pt-BR')} B2B` : ''}`,
        metadata: { b2c, b2b, raw: data },
      }
    } catch (e: any) {
      const status = e?.response?.status
      const detail = e?.response?.data?.detail ?? e?.response?.data?.message ?? e?.message ?? ''
      if (status === 401) {
        // Some 401 responses include "IP not whitelisted" — surface that hint
        if (typeof detail === 'string' && /ip|whitelist/i.test(detail)) {
          return { ok: false, message: `IP não está na whitelist · ${detail}` }
        }
        return { ok: false, message: 'API Key inválida' }
      }
      if (status === 429) return { ok: false, message: 'Limite diário excedido (100/dia · faça whitelist do IP no painel)' }
      return { ok: false, message: `${status ?? ''} ${detail}`.trim() || 'Falha na conexão' }
    }
  }

  /** Map a /persons/ row into the common shape. */
  private mapPerson(r: Record<string, unknown>): EnrichmentResult['data'] {
    const phonesRaw = Array.isArray(r.telefones ?? r.phones) ? (r.telefones ?? r.phones) as Array<Record<string, unknown>> : []
    const emailsRaw = Array.isArray(r.emails)               ? r.emails               as Array<Record<string, unknown>> : []
    const addr      = (r.endereco ?? r.address) as Record<string, unknown> | undefined

    return {
      full_name:  ((r.nome ?? r.name) as string) ?? undefined,
      cpf:        ((r.cpf as string) ?? '').replace(/\D/g, '') || undefined,
      birth_date: (r.data_nascimento as string)?.slice(0, 10),
      gender:     (r.sexo === 'F' || r.gender === 'F') ? 'F'
                : (r.sexo === 'M' || r.gender === 'M') ? 'M' : undefined,
      mother_name: (r.nome_mae as string) ?? undefined,
      phones: phonesRaw.slice(0, 5).map(t => ({
        number:      String(`${t.ddd ?? ''}${t.phone ?? t.number ?? ''}`).replace(/\D/g, ''),
        is_whatsapp: t.is_whatsapp === true,
        is_active:   t.is_active   !== false,
      })),
      emails: emailsRaw.slice(0, 5).map(e => ({
        address:  String((e as { email?: string }).email ?? e ?? ''),
        is_valid: ((e as { status_email?: string }).status_email ?? 'valid') === 'valid',
      })),
      address: addr ? {
        cep:          String(addr.cep ?? '').replace(/\D/g, ''),
        street:       String(addr.logradouro ?? addr.street ?? ''),
        number:       String(addr.numero ?? addr.number ?? ''),
        complement:   String(addr.complemento ?? addr.complement ?? ''),
        neighborhood: String(addr.bairro ?? addr.neighborhood ?? ''),
        city:         String(addr.cidade ?? addr.city ?? ''),
        state:        String(addr.uf ?? addr.state ?? ''),
      } : undefined,
    }
  }

  async enrichCPF(cpf: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const data = await this.get('/persons/', { cpf: cpf.replace(/\D/g, '') }, creds)
      if (!data) return { ...EMPTY_RESULT, quality: 'error', error: 'sem creds', duration_ms: elapsed(t0) }
      const mapped = this.mapPerson(data)
      return {
        success: !!mapped.full_name,
        quality: mapped.full_name ? (mapped.phones?.length ? 'full' : 'partial') : 'empty',
        data: { ...mapped, cpf: cpf.replace(/\D/g, '') },
        raw_response: data, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.response?.data?.detail ?? e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }

  async enrichCNPJ(cnpj: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const data = await this.get('/companies/', { cnpj: cnpj.replace(/\D/g, '') }, creds)
      if (!data) return { ...EMPTY_RESULT, quality: 'error', error: 'sem creds', duration_ms: elapsed(t0) }
      const r = data as Record<string, unknown>
      const phonesRaw = Array.isArray(r.telefones) ? r.telefones as Array<Record<string, unknown>> : []
      const emailsRaw = Array.isArray(r.emails)    ? r.emails    as Array<{ email?: string }> : []
      const addr      = (r.endereco ?? r.address) as Record<string, unknown> | undefined
      return {
        success: !!r.razao_social,
        quality: r.razao_social ? (phonesRaw.length ? 'full' : 'partial') : 'empty',
        data: {
          cnpj:         cnpj.replace(/\D/g, ''),
          company_name: (r.razao_social as string) ?? undefined,
          trade_name:   (r.nome_fantasia as string) ?? undefined,
          legal_status: (r.natureza_juridica as string) ?? undefined,
          phones: phonesRaw.slice(0, 5).map(t => ({
            number: String(`${t.ddd ?? ''}${t.phone ?? ''}`).replace(/\D/g, ''),
          })),
          emails: emailsRaw.slice(0, 5).map(e => ({ address: String(e.email ?? '') })),
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
        raw_response: data, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }

  /** Reverse lookup — phone → person via /persons/search/. */
  async enrichPhone(phone: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const clean = phone.replace(/\D/g, '')
      const data = await this.get('/persons/search/', { phone: clean }, creds)
      if (!data) return { ...EMPTY_RESULT, quality: 'error', error: 'sem creds', duration_ms: elapsed(t0) }
      const list = Array.isArray((data as { results?: unknown }).results)
        ? (data as { results: Array<Record<string, unknown>> }).results
        : Array.isArray(data) ? data as Array<Record<string, unknown>> : []
      const first = list[0]
      if (!first) return { ...EMPTY_RESULT, quality: 'empty', cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0) }
      const mapped = this.mapPerson(first)
      return {
        success: !!mapped.full_name,
        quality: mapped.full_name ? 'partial' : 'empty',
        data: { ...mapped, phones: [{ number: clean, is_active: true }] },
        raw_response: data, cost_cents: this.DEFAULT_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }

  async validateEmail(_email: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void _email; return EMPTY_RESULT }

  /** Real-time WhatsApp probe — DDD + phone separated, free-tier
   * shape: { is_active: boolean } or { status: 'active'|'inactive' }. */
  async validateWhatsApp(phone: string, creds: ProviderCreds): Promise<EnrichmentResult> {
    const t0 = Date.now()
    try {
      const clean = phone.replace(/\D/g, '')
      const ddd = clean.slice(0, 2)
      const num = clean.slice(2)
      const data = await this.get('/whatsapp/search/', { ddd, phone: num }, creds)
      if (!data) return { ...EMPTY_RESULT, quality: 'error', error: 'sem creds', duration_ms: elapsed(t0) }
      // DataStone responde { status: "ATIVO" } (PT uppercase). Normaliza
      // pra aceitar PT/EN, lowercase/uppercase, e variantes is_active/has_whatsapp
      // que possam aparecer em outras versões da API.
      const statusStr = String((data as Record<string, unknown>).status ?? '').toLowerCase()
      const isActive = (data as Record<string, unknown>).is_active === true
                    || statusStr === 'active' || statusStr === 'ativo'
                    || (data as Record<string, unknown>).has_whatsapp === true
      return {
        success: true,
        quality: isActive ? 'full' : 'empty',
        data: { phones: [{ number: clean, is_whatsapp: isActive, is_active: isActive }] },
        raw_response: data, cost_cents: this.WHATSAPP_COST_CENTS, duration_ms: elapsed(t0),
      }
    } catch (e: any) {
      return { ...EMPTY_RESULT, quality: 'error', error: e?.message ?? '', duration_ms: elapsed(t0) }
    }
  }

  async enrichCEP(_cep: string, _creds: ProviderCreds): Promise<EnrichmentResult> { void _cep; return EMPTY_RESULT }
}
