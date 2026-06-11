/** Dicionário ÚNICO de canais do e-Click.
 *
 *  Dois vocabulários convivem no projeto e NÃO são iguais:
 *  - `platform` (product_listings / marketplace_connections / stock sync):
 *    'mercadolivre' | 'shopee' | 'tiktok_shop' | 'storefront' | 'amazon' | 'magalu'
 *  - `content key` (products.channel_titles / channel_descriptions, CHANNEL_KEYS
 *    do enrichment): 'mercado_livre' | 'shopee' | 'tiktok_shop' | 'loja_propria'
 *    | 'amazon' | 'magalu'
 *
 *  Sempre que cruzar conteúdo-por-canal com vínculos/anúncios, converta por
 *  aqui — nunca compare as strings cruas ('mercado_livre' ≠ 'mercadolivre',
 *  'loja_propria' ≠ 'storefront'). Achado da auditoria de multiplicação
 *  de anúncios (2026-06-11). */

export type ChannelPlatform =
  | 'mercadolivre' | 'shopee' | 'tiktok_shop' | 'storefront' | 'amazon' | 'magalu'

export type ChannelContentKey =
  | 'mercado_livre' | 'shopee' | 'tiktok_shop' | 'loja_propria' | 'amazon' | 'magalu'

export const CHANNEL_PLATFORMS: ChannelPlatform[] = [
  'mercadolivre', 'shopee', 'tiktok_shop', 'storefront', 'amazon', 'magalu',
]

const PLATFORM_TO_CONTENT: Record<ChannelPlatform, ChannelContentKey> = {
  mercadolivre: 'mercado_livre',
  shopee:       'shopee',
  tiktok_shop:  'tiktok_shop',
  storefront:   'loja_propria',
  amazon:       'amazon',
  magalu:       'magalu',
}

const CONTENT_TO_PLATFORM: Record<ChannelContentKey, ChannelPlatform> = {
  mercado_livre: 'mercadolivre',
  shopee:        'shopee',
  tiktok_shop:   'tiktok_shop',
  loja_propria:  'storefront',
  amazon:        'amazon',
  magalu:        'magalu',
}

/** Rótulos PT-BR pra UI/logs. */
export const CHANNEL_LABELS: Record<ChannelPlatform, string> = {
  mercadolivre: 'Mercado Livre',
  shopee:       'Shopee',
  tiktok_shop:  'TikTok Shop',
  storefront:   'Loja própria',
  amazon:       'Amazon',
  magalu:       'Magalu',
}

/** Limite prático de TÍTULO por canal (espelha as regras dos publishers /
 *  marketplaces; TikTok aceita até 255). */
export const CHANNEL_TITLE_LIMITS: Record<ChannelPlatform, number> = {
  mercadolivre: 60,
  shopee:       120,
  tiktok_shop:  255,
  storefront:   150,
  amazon:       200,
  magalu:       150,
}

/** platform → content key ('mercadolivre' → 'mercado_livre'). Aceita também
 *  receber a própria content key (idempotente). null = canal desconhecido. */
export function contentKeyFor(platformOrKey: string | null | undefined): ChannelContentKey | null {
  if (!platformOrKey) return null
  const p = platformOrKey.trim().toLowerCase()
  if (p in PLATFORM_TO_CONTENT) return PLATFORM_TO_CONTENT[p as ChannelPlatform]
  if (p in CONTENT_TO_PLATFORM) return p as ChannelContentKey
  return null
}

/** content key → platform ('loja_propria' → 'storefront'). Aceita também a
 *  própria platform (idempotente). null = canal desconhecido. */
export function platformFor(keyOrPlatform: string | null | undefined): ChannelPlatform | null {
  if (!keyOrPlatform) return null
  const k = keyOrPlatform.trim().toLowerCase()
  if (k in CONTENT_TO_PLATFORM) return CONTENT_TO_PLATFORM[k as ChannelContentKey]
  if (k in PLATFORM_TO_CONTENT) return k as ChannelPlatform
  return null
}
