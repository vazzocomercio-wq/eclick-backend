import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabase } from '../../supabase.js'
import type { OrgToken } from '../token-client.js'
import { getCatalogOffers, getItem, sleep } from '../ml-api.js'
import type { MlCatalogItem } from '../types.js'
import { radarLog, errMsg } from '../util.js'

export interface OffersResult {
  catalog_products: number
  offers_upserted: number
  offers_deactivated: number
  errors: number
}

/**
 * Coletor de ofertas — para cada produto de catálogo ativo da org, busca o
 * conjunto competitivo (/products/{id}/items), faz upsert em radar_offers,
 * grava snapshot, e desativa ofertas que sumiram do conjunto.
 */
export async function collectOffers(orgId: string, tok: OrgToken): Promise<OffersResult> {
  const sb = getSupabase()
  const r: OffersResult = { catalog_products: 0, offers_upserted: 0, offers_deactivated: 0, errors: 0 }

  const { data: products, error } = await sb
    .from('radar_catalog_products')
    .select('id, catalog_product_id')
    .eq('organization_id', orgId)
    .eq('status', 'ativo')
  if (error) throw new Error(`radar_catalog_products read: ${error.message}`)

  for (const cp of products ?? []) {
    r.catalog_products++
    try {
      const offers = await getCatalogOffers(cp.catalog_product_id as string, tok)
      const prices = offers.map((o) => o.price).filter((p): p is number => typeof p === 'number')
      const minPrice = prices.length ? Math.min(...prices) : null
      const seen: string[] = []

      for (const offer of offers) {
        try {
          await upsertOffer(sb, orgId, cp.id as string, offer, minPrice, tok)
          seen.push(offer.item_id)
          r.offers_upserted++
        } catch (e) {
          r.errors++
          radarLog('offers', 'upsert oferta falhou', offer.item_id, errMsg(e))
        }
      }

      r.offers_deactivated += await deactivateMissing(sb, orgId, cp.id as string, seen)
      await sleep(200)
    } catch (e) {
      r.errors++
      radarLog('offers', 'catálogo falhou', cp.catalog_product_id, errMsg(e))
    }
  }
  return r
}

async function upsertOffer(
  sb: SupabaseClient,
  orgId: string,
  catalogRef: string,
  offer: MlCatalogItem,
  minPrice: number | null,
  tok: OrgToken,
): Promise<void> {
  const isOwn = tok.isOwnSeller(offer.seller_id)
  const sellerRef = await ensureSeller(sb, orgId, offer.seller_id)

  // sold/available_quantity só do item PRÓPRIO — concorrente é 403 (inacessível).
  let soldQuantity: number | null = null
  let availableQuantity: number | null = null
  if (isOwn) {
    try {
      const item = await getItem(offer.item_id, tok)
      soldQuantity = typeof item.sold_quantity === 'number' ? item.sold_quantity : null
      availableQuantity = typeof item.available_quantity === 'number' ? item.available_quantity : null
    } catch (e) {
      radarLog('offers', 'getItem próprio falhou', offer.item_id, errMsg(e))
    }
  }

  // "menor preço" do conjunto competitivo — NÃO é o buy-box winner (que o ML
  // não expõe: buy_box_winner vem null e /products/{id}/items não tem ganhador).
  const isLowestPrice = offer.price != null && minPrice != null && offer.price === minPrice
  const now = new Date().toISOString()
  const freeShipping = offer.shipping?.free_shipping ?? null
  const logisticType = offer.shipping?.logistic_type ?? null

  const { error } = await sb.from('radar_offers').upsert(
    {
      organization_id: orgId,
      platform: 'mercadolivre',
      catalog_product_ref: catalogRef,
      seller_ref: sellerRef,
      item_id: offer.item_id,
      price: offer.price,
      free_shipping: freeShipping,
      logistic_type: logisticType,
      listing_type: offer.listing_type_id,
      condition: offer.condition,
      is_lowest_price: isLowestPrice,
      is_own: isOwn,
      sold_quantity: soldQuantity,
      available_quantity: availableQuantity,
      permalink: offer.permalink ?? null,
      thumbnail: offer.thumbnail ?? null,
      status: 'ativo',
      last_seen_at: now,
      updated_at: now,
    },
    { onConflict: 'organization_id,platform,item_id' },
  )
  if (error) throw new Error(error.message)

  const { error: snapErr } = await sb.from('radar_offer_snapshots').insert({
    organization_id: orgId,
    catalog_product_ref: catalogRef,
    item_id: offer.item_id,
    seller_ref: sellerRef,
    price: offer.price,
    free_shipping: freeShipping,
    logistic_type: logisticType,
    is_lowest_price: isLowestPrice,
    collected_at: now,
  })
  if (snapErr) throw new Error(`snapshot: ${snapErr.message}`)
}

/** Garante uma linha em radar_sellers (mínima — o coletor de sellers enriquece depois). */
async function ensureSeller(sb: SupabaseClient, orgId: string, sellerId: number): Promise<string> {
  const { data, error } = await sb
    .from('radar_sellers')
    .upsert(
      {
        organization_id: orgId,
        platform: 'mercadolivre',
        seller_id: sellerId,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,platform,seller_id' },
    )
    .select('id')
    .single()
  if (error || !data) throw new Error(`ensureSeller ${sellerId}: ${error?.message ?? 'sem id'}`)
  return data.id as string
}

/** Ofertas ativas desse catálogo que não apareceram na coleta → status='inativo'. */
async function deactivateMissing(
  sb: SupabaseClient,
  orgId: string,
  catalogRef: string,
  seenItemIds: string[],
): Promise<number> {
  let q = sb
    .from('radar_offers')
    .update({ status: 'inativo', updated_at: new Date().toISOString() })
    .eq('organization_id', orgId)
    .eq('catalog_product_ref', catalogRef)
    .eq('status', 'ativo')
  if (seenItemIds.length > 0) {
    q = q.not('item_id', 'in', `(${seenItemIds.join(',')})`)
  }
  const { data, error } = await q.select('id')
  if (error) throw new Error(`deactivate: ${error.message}`)
  return data?.length ?? 0
}
