import { supabaseAdmin } from './supabase'

/**
 * Vínculo anúncio↔produto de catálogo (`product_listings`) — é o que o motor de
 * estoque unificado (StockService.recalcAndPropagate / syncToMl) lê pra propagar
 * estoque/preço pros anúncios. A CHAVE DE CONEXÃO é o SKU: o produto de catálogo
 * é resolvido pelo SKU do anúncio (ou pelo vínculo direto, quando já existe).
 *
 * Convenção de `platform` em product_listings (≠ creative_publications.marketplace):
 *   - Mercado Livre = 'mercadolivre' (SEM underscore — é o que o syncToMl filtra)
 *   - Shopee        = 'shopee'        (account_id = shop_id, variation_id = '')
 *   - TikTok Shop   = 'tiktok_shop'   (account_id = null,    variation_id = null)
 */

/** Resolve products.id pela CHAVE SKU (org-scoped) ou pelo vínculo direto.
 *  Retorna null se não casar — aí o anúncio fica sem vínculo (sem estoque). */
export async function resolveCatalogProductIdBySku(
  orgId: string,
  opts: { directProductId?: string | null; sku?: string | null },
): Promise<string | null> {
  if (opts.directProductId) return opts.directProductId
  const sku = opts.sku?.trim()
  if (!sku) return null
  const { data } = await supabaseAdmin
    .from('products')
    .select('id')
    .eq('organization_id', orgId)
    .eq('sku', sku)
    .maybeSingle<{ id: string }>()
  return data?.id ?? null
}

/** Cria/atualiza o vínculo em product_listings. Idempotente por
 *  (platform, listing_id) — evita duplicar e contorna o NULL em
 *  variation_id/account_id (que furaria um onConflict composto). Não-fatal:
 *  o caller deve envolver em try/catch. */
export async function linkProductListing(args: {
  platform:     'mercadolivre' | 'shopee' | 'tiktok_shop'
  listingId:    string
  productId:    string
  accountId?:   string | null
  variationId?: string | null
  title?:       string | null
  price?:       number | null
}): Promise<'inserted' | 'updated'> {
  const { data: existing } = await supabaseAdmin
    .from('product_listings')
    .select('id')
    .eq('platform', args.platform)
    .eq('listing_id', args.listingId)
    .maybeSingle<{ id: string }>()

  const row: Record<string, unknown> = {
    product_id:    args.productId,
    account_id:    args.accountId ?? null,
    variation_id:  args.variationId ?? null,
    listing_title: args.title ?? null,
    listing_price: args.price ?? null,
    is_active:     true,
  }

  if (existing) {
    await supabaseAdmin.from('product_listings').update(row).eq('id', existing.id)
    return 'updated'
  }
  await supabaseAdmin
    .from('product_listings')
    .insert({ platform: args.platform, listing_id: args.listingId, ...row })
  return 'inserted'
}
