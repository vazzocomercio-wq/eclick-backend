import { Injectable, Logger, HttpException } from '@nestjs/common'
import * as crypto from 'crypto'
import { supabaseAdmin } from '../../common/supabase'

const IV_LENGTH = 16

/** Org em modo BYOK ('own') tentou usar IA sem chave própria configurada.
 *  HTTP 402 (Payment Required) + payload estruturado pro frontend detectar
 *  e mostrar o CTA "Conectar chave de IA". */
export class AiKeyRequiredException extends HttpException {
  constructor(provider: string) {
    super(
      {
        statusCode: 402,
        error:      'ai_key_required',
        provider,
        message:    `Conecte sua chave de ${provider} em Configurações > IA pra usar este recurso.`,
      },
      402,
    )
  }
}

@Injectable()
export class CredentialsService {
  private readonly logger = new Logger(CredentialsService.name)

  private get encryptionKey(): Buffer {
    const key = process.env.ENCRYPTION_KEY
    if (!key || key.length !== 32) {
      this.logger.error('ENCRYPTION_KEY must be exactly 32 characters. Set it in environment variables.')
      throw new Error('ENCRYPTION_KEY not configured or invalid length')
    }
    return Buffer.from(key, 'utf8')
  }

  encrypt(text: string): string {
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv('aes-256-cbc', this.encryptionKey, iv)
    let encrypted = cipher.update(text)
    encrypted = Buffer.concat([encrypted, cipher.final()])
    return iv.toString('hex') + ':' + encrypted.toString('hex')
  }

  decrypt(text: string): string {
    const [ivHex, encryptedHex] = text.split(':')
    const iv        = Buffer.from(ivHex, 'hex')
    const encrypted = Buffer.from(encryptedHex, 'hex')
    const decipher  = crypto.createDecipheriv('aes-256-cbc', this.encryptionKey, iv)
    let decrypted   = decipher.update(encrypted)
    decrypted       = Buffer.concat([decrypted, decipher.final()])
    return decrypted.toString()
  }

  maskKey(key: string): string {
    if (key.length <= 12) return '****'
    return key.substring(0, 8) + '****...****' + key.substring(key.length - 4)
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /** Batch 1.6 — onConflict agora inclui organization_id pra suportar
   * multi-tenant. Antes, conexão de uma org sobrescrevia a de outra
   * com mesmo (provider, key_name). Migration
   * 2026_04_29_api_credentials_org_unique.sql precisa ter rodado pra
   * o UNIQUE composto existir no DB. */
  async saveCredential(orgId: string | null, userId: string, provider: string, keyName: string, keyValue: string) {
    const encrypted = this.encrypt(keyValue)
    const preview   = this.maskKey(keyValue)

    const { data, error } = await supabaseAdmin
      .from('api_credentials')
      .upsert({
        organization_id: orgId,
        user_id:         userId,
        provider,
        key_name:  keyName,
        key_value: encrypted,
        key_preview: preview,
        is_active:   true,
        updated_at:  new Date().toISOString(),
      }, { onConflict: 'organization_id,provider,key_name' })
      .select('id, provider, key_name, key_preview, is_active, last_tested_at, last_test_status, last_test_message')
      .single()

    if (error) throw error
    return { ...data, success: true }
  }

  async listCredentials(orgId: string | null) {
    const q = supabaseAdmin
      .from('api_credentials')
      .select('id, provider, key_name, key_preview, is_active, last_tested_at, last_test_status, last_test_message, created_at')
      .eq('is_active', true)
      .order('provider')

    const { data, error } = orgId
      ? await q.eq('organization_id', orgId)
      : await q

    if (error) throw error
    return data ?? []
  }

  async deleteCredential(orgId: string | null, id: string) {
    const q = supabaseAdmin.from('api_credentials').delete().eq('id', id)
    const { error } = orgId ? await q.eq('organization_id', orgId) : await q
    if (error) throw error
    return { ok: true }
  }

  async getDecryptedKey(orgId: string | null, provider: string, keyName?: string): Promise<string | null> {
    let q = supabaseAdmin
      .from('api_credentials')
      .select('key_value')
      .eq('provider', provider)
      .eq('is_active', true)

    if (orgId) q = q.eq('organization_id', orgId)
    if (keyName) q = q.eq('key_name', keyName)

    const { data } = await q.maybeSingle()
    if (!data) return null
    try {
      return this.decrypt(data.key_value)
    } catch (e) {
      // AI-ABS-2: log com contexto pra debug. Causas comuns: ENCRYPTION_KEY
      // mudou no env (chave antiga não descriptar mais), iv/ciphertext
      // corrompidos. NÃO loga key_value nem encryptionKey — só erro.
      this.logger.warn(
        `[getDecryptedKey] decrypt falhou orgId=${orgId ?? 'global'} ` +
        `provider=${provider} keyName=${keyName ?? '(any)'}: ${(e as Error).message}`
      )
      return null
    }
  }

  // ── BYOK resolution ─────────────────────────────────────────────────────────

  /**
   * Resolve a chave de IA respeitando o modo BYOK da org (Fase A passo 2).
   *
   *   1. org com chave própria        → usa ela (cliente paga com o crédito dele).
   *   2. org modo 'platform' sem chave → chave global da plataforma (só a matriz Vazzo).
   *   3. org modo 'own' sem chave      → lança AiKeyRequiredException (402).
   *
   * Substitui o padrão `getDecryptedKey(org) ?? getDecryptedKey(null)` que
   * fazia TODA org cair na chave global da plataforma (= dono pagando pelos
   * clientes).
   */
  async resolveAiKey(orgId: string | null, provider: string, keyName?: string): Promise<string> {
    if (orgId) {
      const own = await this.getDecryptedKey(orgId, provider, keyName)
      if (own) return own
    }

    const mode = orgId ? await this.getOrgAiKeysMode(orgId) : 'platform'
    if (mode === 'platform') {
      const platform = await this.getPlatformKey(provider, keyName)
      if (platform) return platform
      // Plataforma sem a chave global cadastrada — erro de config nosso.
      throw new HttpException(`Chave ${provider} da plataforma não configurada`, 500)
    }

    // Modo 'own' sem chave própria → BYOK obrigatório.
    throw new AiKeyRequiredException(provider)
  }

  /** Modo de chaves de IA da org. Default 'own' (BYOK) pra qualquer org sem o flag. */
  async getOrgAiKeysMode(orgId: string): Promise<'platform' | 'own'> {
    const { data } = await supabaseAdmin
      .from('organizations')
      .select('ai_keys_mode')
      .eq('id', orgId)
      .maybeSingle()
    return data?.ai_keys_mode === 'platform' ? 'platform' : 'own'
  }

  /** Chave GLOBAL da plataforma (organization_id IS NULL) — só a matriz usa. */
  private async getPlatformKey(provider: string, keyName?: string): Promise<string | null> {
    let q = supabaseAdmin
      .from('api_credentials')
      .select('key_value')
      .eq('provider', provider)
      .eq('is_active', true)
      .is('organization_id', null)
    if (keyName) q = q.eq('key_name', keyName)

    const { data } = await q.maybeSingle()
    if (!data) return null
    try {
      return this.decrypt(data.key_value)
    } catch (e) {
      this.logger.warn(`[getPlatformKey] decrypt falhou provider=${provider}: ${(e as Error).message}`)
      return null
    }
  }

  // ── Test ──────────────────────────────────────────────────────────────────

  async testCredential(orgId: string | null, id: string) {
    const { data: cred } = await supabaseAdmin
      .from('api_credentials')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (!cred) return { ok: false, message: 'Credencial não encontrada' }

    let decrypted: string
    try { decrypted = this.decrypt(cred.key_value) } catch {
      return { ok: false, message: 'Falha ao descriptografar a chave' }
    }

    const result = await this.runTest(cred.provider, decrypted)

    await supabaseAdmin.from('api_credentials').update({
      last_tested_at:      new Date().toISOString(),
      last_test_status:    result.ok ? 'ok' : 'error',
      last_test_message:   result.message,
    }).eq('id', id)

    return result
  }

  private async runTest(provider: string, key: string): Promise<{ ok: boolean; message: string }> {
    try {
      if (provider === 'openai') {
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${key}` },
        })
        if (res.ok) return { ok: true, message: 'OpenAI conectada ✅' }
        const err = await res.json().catch(() => ({}))
        return { ok: false, message: (err as { error?: { message?: string } }).error?.message ?? `Erro HTTP ${res.status}` }
      }

      if (provider === 'anthropic') {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 5,
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        })
        if (res.ok) return { ok: true, message: 'Claude conectado ✅' }
        const err = await res.json().catch(() => ({}))
        return { ok: false, message: (err as { error?: { message?: string } }).error?.message ?? `Erro HTTP ${res.status}` }
      }

      if (provider === 'google') {
        // Lista modelos do Gemini — valida a chave sem gastar tokens.
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
        )
        if (res.ok) return { ok: true, message: 'Gemini conectado ✅' }
        const err = await res.json().catch(() => ({}))
        return { ok: false, message: (err as { error?: { message?: string } }).error?.message ?? `Erro HTTP ${res.status}` }
      }

      return { ok: true, message: 'Chave salva (sem teste disponível para este provedor)' }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  }
}
