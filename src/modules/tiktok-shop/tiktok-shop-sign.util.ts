import * as crypto from 'node:crypto'

/**
 * Assinatura das APIs de negócio do TikTok Shop (open-api.tiktokglobalshop.com).
 *
 * Algoritmo (TikTok Shop API v2 / 202309):
 *   1. Pega os params de query EXCETO `sign` e `access_token`.
 *   2. Ordena as chaves alfabeticamente.
 *   3. Concatena cada par como `{key}{value}` (sem separador).
 *   4. base = {path} + concat
 *   5. Se houver body (JSON, não multipart): base += {body}
 *   6. wrapped = {app_secret} + base + {app_secret}
 *   7. sign = HMAC-SHA256(key = app_secret, wrapped) em hex.
 *
 * Doc: https://partner.tiktokshop.com/docv2/page/signature-generation
 */
export function signTikTokShop(args: {
  appSecret: string
  path: string
  query: Record<string, string | number | undefined>
  body?: string
}): string {
  const { appSecret, path, query, body } = args

  const keys = Object.keys(query)
    .filter(
      (k) =>
        k !== 'sign' &&
        k !== 'access_token' &&
        query[k] !== undefined &&
        query[k] !== '',
    )
    .sort()

  let base = path
  for (const k of keys) base += `${k}${query[k]}`
  if (body) base += body

  const wrapped = `${appSecret}${base}${appSecret}`
  return crypto.createHmac('sha256', appSecret).update(wrapped).digest('hex')
}
