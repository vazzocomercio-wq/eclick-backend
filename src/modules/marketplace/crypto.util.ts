import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

/** AES-256-GCM com chave derivada de MARKETPLACE_CONFIG_KEY (env).
 * Formato persistido: JSON { v: 1, alg: 'aes-256-gcm', iv, tag, ct } base64.
 *
 * Migrar pra Supabase Vault quando suportar multi-tenant; por ora é
 * single-key per-deploy. Rotação manual (env nova → re-encrypt batch). */

const ALGORITHM = 'aes-256-gcm'
const SALT      = 'eclick-marketplace-config-v1'  // estático ok — derive scrypt(env, salt)

function getKey(): Buffer {
  const env = process.env.MARKETPLACE_CONFIG_KEY
  if (!env) throw new Error('MARKETPLACE_CONFIG_KEY não está configurado no servidor')
  // scrypt deriva 32 bytes (256 bits) a partir de qualquer length de env
  return scryptSync(env, SALT, 32)
}

export function encryptConfig(plain: Record<string, unknown> | null): string | null {
  if (plain == null) return null
  const json = JSON.stringify(plain)
  const iv   = randomBytes(12)  // 12 bytes pra GCM (recomendado)
  const cipher = createCipheriv(ALGORITHM, getKey(), iv)
  const ct  = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return JSON.stringify({
    v:   1,
    alg: ALGORITHM,
    iv:  iv.toString('base64'),
    tag: tag.toString('base64'),
    ct:  ct.toString('base64'),
  })
}

export function decryptConfig(encrypted: string | null | undefined): Record<string, unknown> | null {
  if (!encrypted) return null
  let payload: { v: number; alg: string; iv: string; tag: string; ct: string }
  try {
    payload = JSON.parse(encrypted)
  } catch {
    return null
  }
  if (payload.v !== 1 || payload.alg !== ALGORITHM) {
    throw new Error(`Formato de config_encrypted desconhecido: v=${payload.v} alg=${payload.alg}`)
  }
  const iv  = Buffer.from(payload.iv,  'base64')
  const tag = Buffer.from(payload.tag, 'base64')
  const ct  = Buffer.from(payload.ct,  'base64')
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv)
  decipher.setAuthTag(tag)
  const json = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  return JSON.parse(json) as Record<string, unknown>
}
