import { Injectable, Logger } from '@nestjs/common'
import axios, { AxiosError } from 'axios'

export interface ZapiSendResult {
  success:        boolean
  zapiMessageId?: string
  error?:         string
}

export interface ZapiStatusResult {
  connected: boolean
  phone?:    string
  battery?:  number
  signal?:   number
  raw?:      Record<string, unknown>
}

/** Z-API provider. Auth via header Client-Token + path-injected
 * INSTANCE_ID/TOKEN. Configurado por env: ZAPI_INSTANCE_ID, ZAPI_TOKEN,
 * ZAPI_CLIENT_TOKEN, ZAPI_BASE_URL (default https://api.z-api.io).
 *
 * Retry automático 1× em 429/503 com 2s de delay — Z-API costuma cuspir
 * essas respostas quando o WhatsApp Web da instância está reiniciando. */
@Injectable()
export class ZapiProvider {
  private readonly logger = new Logger(ZapiProvider.name)

  /** True quando todas as env vars críticas estão setadas. Usado pelo
   * WhatsAppSender pra decidir entre ZAPI e Meta legado. */
  isConfigured(): boolean {
    return !!(process.env.ZAPI_INSTANCE_ID && process.env.ZAPI_TOKEN && process.env.ZAPI_CLIENT_TOKEN)
  }

  private baseUrl(): string {
    const root = process.env.ZAPI_BASE_URL ?? 'https://api.z-api.io'
    return `${root}/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}`
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type':  'application/json',
      'Client-Token':  process.env.ZAPI_CLIENT_TOKEN ?? '',
    }
  }

  /** Strip não-dígitos e garante country code BR. Z-API aceita só
   * dígitos com country code (ex: "5571999998050"). Lógica:
   *   10 dígitos (DD+8 telefone fixo) → prefixa 55 → 12 dígitos
   *   11 dígitos (DD+9 celular)        → prefixa 55 → 13 dígitos
   *   12-13 dígitos                    → assume já com country code
   *   demais                            → retorna raw (Z-API rejeita)
   * Testado: "+55 (71) 99999-8050" → "5571999998050",
   *           "71993167000"          → "5571993167000". */
  static normalizePhone(input: string): string {
    const digits = (input ?? '').replace(/\D/g, '')
    if (digits.length === 10 || digits.length === 11) return `55${digits}`
    return digits
  }

  /** Mascara pra log: mantém só os 4 últimos dígitos. */
  private mask(phone: string): string {
    if (phone.length <= 4) return phone
    return '*'.repeat(phone.length - 4) + phone.slice(-4)
  }

  async sendText(phone: string, message: string): Promise<ZapiSendResult> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Z-API não configurado (env vars ausentes)' }
    }
    const norm = ZapiProvider.normalizePhone(phone)
    if (!norm) return { success: false, error: 'phone inválido' }

    const masked = this.mask(norm)
    const url    = `${this.baseUrl()}/send-text`

    const result = await this.postWithRetry<{ zaapId?: string; messageId?: string; id?: string }>(
      url,
      { phone: norm, message },
    )
    if (!result.ok) {
      this.logger.warn(`[zapi.send] phone=${masked} status=failed err=${result.error}`)
      return { success: false, error: result.error }
    }
    const id = result.data?.messageId ?? result.data?.zaapId ?? result.data?.id
    this.logger.log(`[zapi.send] phone=${masked} status=sent id=${id ?? '?'}`)
    return { success: true, zapiMessageId: id }
  }

  async sendImage(
    phone: string, imageUrl: string, caption?: string,
  ): Promise<ZapiSendResult> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Z-API não configurado' }
    }
    const norm   = ZapiProvider.normalizePhone(phone)
    if (!norm) return { success: false, error: 'phone inválido' }
    const url    = `${this.baseUrl()}/send-image`
    const body   = { phone: norm, image: imageUrl, caption: caption ?? '' }
    const masked = this.mask(norm)

    const result = await this.postWithRetry<{ zaapId?: string; messageId?: string; id?: string }>(url, body)
    if (!result.ok) {
      this.logger.warn(`[zapi.send-image] phone=${masked} status=failed err=${result.error}`)
      return { success: false, error: result.error }
    }
    const id = result.data?.messageId ?? result.data?.zaapId ?? result.data?.id
    this.logger.log(`[zapi.send-image] phone=${masked} status=sent id=${id ?? '?'}`)
    return { success: true, zapiMessageId: id }
  }

  /** GET /status — connected/phone/battery. Z-API costuma retornar
   * { connected: bool, phone?: string, battery?: number, ... }. Tudo
   * é lido como opcional pra suportar variações entre versões da API. */
  async getStatus(): Promise<ZapiStatusResult> {
    if (!this.isConfigured()) {
      return { connected: false }
    }
    try {
      const { data } = await axios.get(`${this.baseUrl()}/status`, {
        headers: this.headers(),
        timeout: 10_000,
      })
      const raw = (data ?? {}) as Record<string, unknown>
      return {
        connected: Boolean(raw.connected),
        phone:     (raw.phone as string | undefined) ?? (raw.session as string | undefined) ?? undefined,
        battery:   typeof raw.battery === 'number' ? raw.battery : undefined,
        signal:    typeof raw.signal  === 'number' ? raw.signal  : undefined,
        raw,
      }
    } catch (e: unknown) {
      const err = this.errMsg(e)
      this.logger.warn(`[zapi.status] falhou: ${err}`)
      return { connected: false }
    }
  }

  async healthCheck(): Promise<boolean> {
    const s = await this.getStatus()
    return s.connected === true
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private async postWithRetry<T>(
    url: string, body: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: T; error?: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { data } = await axios.post<T>(url, body, {
          headers: this.headers(),
          timeout: 15_000,
        })
        return { ok: true, data }
      } catch (e: unknown) {
        const status = (e as AxiosError)?.response?.status ?? 0
        const err    = this.errMsg(e)
        // Retry só em 429/503 e só na 1ª tentativa
        if (attempt === 0 && (status === 429 || status === 503)) {
          await new Promise(r => setTimeout(r, 2000))
          continue
        }
        return { ok: false, error: err }
      }
    }
    // Inalcançável — TS quer return explícito
    return { ok: false, error: 'retry exhausted' }
  }

  private errMsg(e: unknown): string {
    const ax = e as AxiosError<{ error?: string; message?: string }>
    return ax?.response?.data?.error
      ?? ax?.response?.data?.message
      ?? ax?.message
      ?? 'erro desconhecido'
  }
}
