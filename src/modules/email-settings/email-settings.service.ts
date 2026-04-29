import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import axios, { AxiosError } from 'axios'
import { supabaseAdmin } from '../../common/supabase'

export type EmailProvider = 'resend' | 'sendgrid'

export interface EmailSettingsDto {
  provider:     EmailProvider
  api_key:      string
  from_name:    string
  from_address: string
}

export interface EmailSettingsView {
  id:              string
  provider:        EmailProvider
  api_key_preview: string                // ****abcd
  from_name:       string
  from_address:    string
  is_verified:     boolean
  last_tested_at:  string | null
  last_test_error: string | null
  updated_at:      string
}

interface EmailSettingsRow {
  id:               string
  organization_id:  string
  provider:         EmailProvider
  api_key_enc:      string
  from_name:        string
  from_address:     string
  is_verified:      boolean
  last_tested_at:   string | null
  last_test_error:  string | null
  created_at:       string
  updated_at:       string
}

const ALGO = 'aes-256-cbc'
const IV_LENGTH = 16

/** AES-256-CBC encryption + axios POST pros providers Resend/SendGrid. Key
 * derivada via scrypt da env ENCRYPTION_KEY. Formato gravado em api_key_enc:
 * "<iv_hex>:<ciphertext_hex>". Sem ENCRYPTION_KEY o módulo recusa qualquer
 * write — fail-loud em vez de salvar plaintext. */
@Injectable()
export class EmailSettingsService {
  private readonly logger = new Logger(EmailSettingsService.name)
  private readonly key: Buffer | null

  constructor() {
    const raw = process.env.ENCRYPTION_KEY
    if (!raw) {
      this.logger.warn('[email-settings] ENCRYPTION_KEY ausente — escrita/leitura de credenciais desabilitada')
      this.key = null
    } else {
      // scrypt deriva 32 bytes de qualquer string. Salt fixo é OK aqui porque
      // a key não é compartilhada entre orgs — só single-app secret.
      this.key = scryptSync(raw, 'eclick-email-settings-salt', 32)
    }
  }

  private encrypt(plaintext: string): string {
    if (!this.key) throw new BadRequestException('ENCRYPTION_KEY não configurada no backend')
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGO, this.key, iv)
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return `${iv.toString('hex')}:${enc.toString('hex')}`
  }

  private decrypt(stored: string): string {
    if (!this.key) throw new BadRequestException('ENCRYPTION_KEY não configurada no backend')
    const [ivHex, encHex] = stored.split(':')
    if (!ivHex || !encHex) throw new BadRequestException('api_key_enc com formato inválido')
    const iv  = Buffer.from(ivHex, 'hex')
    const enc = Buffer.from(encHex, 'hex')
    const decipher = createDecipheriv(ALGO, this.key, iv)
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
  }

  private mask(apiKey: string): string {
    const last4 = apiKey.slice(-4)
    return `****${last4}`
  }

  private toView(row: EmailSettingsRow): EmailSettingsView {
    let preview = '****'
    try { preview = this.mask(this.decrypt(row.api_key_enc)) } catch { /* fallback */ }
    return {
      id:              row.id,
      provider:        row.provider,
      api_key_preview: preview,
      from_name:       row.from_name,
      from_address:    row.from_address,
      is_verified:     row.is_verified,
      last_tested_at:  row.last_tested_at,
      last_test_error: row.last_test_error,
      updated_at:      row.updated_at,
    }
  }

  /** Retorna config da org (sem decryptar — preview com últimos 4 chars). */
  async get(orgId: string): Promise<EmailSettingsView | null> {
    if (!orgId) throw new BadRequestException('orgId obrigatório')
    const { data } = await supabaseAdmin
      .from('email_settings')
      .select('*')
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!data) return null
    return this.toView(data as unknown as EmailSettingsRow)
  }

  /** Upsert por organization_id (UNIQUE). Criptografa api_key antes de salvar. */
  async save(orgId: string, dto: EmailSettingsDto): Promise<EmailSettingsView> {
    if (!orgId)             throw new BadRequestException('orgId obrigatório')
    if (!dto.api_key?.trim())     throw new BadRequestException('api_key obrigatório')
    if (!dto.from_name?.trim())   throw new BadRequestException('from_name obrigatório')
    if (!dto.from_address?.trim()) throw new BadRequestException('from_address obrigatório')
    if (!['resend', 'sendgrid'].includes(dto.provider)) {
      throw new BadRequestException('provider deve ser resend ou sendgrid')
    }

    const enc = this.encrypt(dto.api_key.trim())

    const { data, error } = await supabaseAdmin
      .from('email_settings')
      .upsert(
        {
          organization_id: orgId,
          provider:        dto.provider,
          api_key_enc:     enc,
          from_name:       dto.from_name.trim(),
          from_address:    dto.from_address.trim(),
          is_verified:     false,
          last_tested_at:  null,
          last_test_error: null,
          updated_at:      new Date().toISOString(),
        },
        { onConflict: 'organization_id' },
      )
      .select('*')
      .single()
    if (error || !data) throw new BadRequestException(error?.message ?? 'Falha ao salvar')
    return this.toView(data as unknown as EmailSettingsRow)
  }

  async remove(orgId: string): Promise<{ ok: true }> {
    if (!orgId) throw new BadRequestException('orgId obrigatório')
    const { error } = await supabaseAdmin
      .from('email_settings')
      .delete()
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)
    return { ok: true }
  }

  /** Decripta a api_key da org pra uso interno do EmailSenderService. */
  async getDecryptedKey(orgId: string): Promise<{
    provider: EmailProvider; apiKey: string; fromName: string; fromAddress: string
  } | null> {
    if (!orgId) return null
    const { data } = await supabaseAdmin
      .from('email_settings')
      .select('*')
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!data) return null
    const row = data as unknown as EmailSettingsRow
    return {
      provider:    row.provider,
      apiKey:      this.decrypt(row.api_key_enc),
      fromName:    row.from_name,
      fromAddress: row.from_address,
    }
  }

  /** Envia email de teste pra um destinatário (geralmente o próprio usuário
   * logado). Atualiza last_tested_at + is_verified ou last_test_error. */
  async test(orgId: string, recipient: string): Promise<{ ok: boolean; error?: string }> {
    if (!recipient) throw new BadRequestException('destinatário obrigatório')
    const cfg = await this.getDecryptedKey(orgId)
    if (!cfg) throw new NotFoundException('Email não configurado pra essa org')

    const subject = 'Teste de envio · e-Click Comércio'
    const body    = `<p>Olá! Este é um email de teste do e-Click pra validar a configuração de envio.</p>
                     <p>Provider: <b>${cfg.provider}</b><br/>Remetente: <b>${cfg.fromName} &lt;${cfg.fromAddress}&gt;</b></p>
                     <p>Se você recebeu, está tudo OK. Pode ignorar.</p>`

    const result = await this.sendVia(cfg.provider, cfg.apiKey, cfg.fromName, cfg.fromAddress, recipient, subject, body)

    await supabaseAdmin
      .from('email_settings')
      .update({
        is_verified:     result.ok,
        last_tested_at:  new Date().toISOString(),
        last_test_error: result.ok ? null : (result.error ?? 'erro desconhecido'),
        updated_at:      new Date().toISOString(),
      })
      .eq('organization_id', orgId)

    return result
  }

  /** HTTP call low-level. Exposto pra reuso pelo EmailSenderService. */
  async sendVia(
    provider: EmailProvider, apiKey: string,
    fromName: string, fromAddress: string,
    to: string, subject: string, body: string,
  ): Promise<{ ok: boolean; error?: string; messageId?: string }> {
    const from = fromName ? `${fromName} <${fromAddress}>` : fromAddress
    try {
      if (provider === 'resend') {
        const res = await axios.post<{ id?: string }>(
          'https://api.resend.com/emails',
          { from, to: [to], subject, html: body },
          {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 15_000,
          },
        )
        return { ok: true, messageId: res.data?.id }
      }
      // sendgrid
      const res = await axios.post(
        'https://api.sendgrid.com/v3/mail/send',
        {
          personalizations: [{ to: [{ email: to }] }],
          from:    { email: fromAddress, name: fromName || undefined },
          subject,
          content: [{ type: 'text/html', value: body }],
        },
        {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: 15_000,
        },
      )
      // SendGrid retorna 202 + header X-Message-Id (não no body).
      const messageId = (res.headers?.['x-message-id'] as string | undefined) ?? undefined
      return { ok: true, messageId }
    } catch (e: unknown) {
      if (e instanceof AxiosError) {
        const body = e.response?.data as { message?: string; errors?: Array<{ message: string }> } | undefined
        const msg = body?.message
                 ?? body?.errors?.[0]?.message
                 ?? e.message
        this.logger.error(`[email-settings] ${provider} HTTP ${e.response?.status ?? '?'}: ${msg}`)
        return { ok: false, error: msg }
      }
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error(`[email-settings] exception: ${msg}`)
      return { ok: false, error: msg }
    }
  }
}
