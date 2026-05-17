import { getSupabase } from '../../supabase.js'
import type { OrgToken } from '../token-client.js'
import { getOwnItemIds, resolveOwnItemsCatalog } from '../ml-api.js'
import { radarLog, errMsg } from '../util.js'

export interface DiscoveryResult {
  own_items: number
  catalog_found: number
  errors: number
}

/**
 * Coletor de descoberta — amplia a watchlist. Enumera os anúncios próprios da
 * org, resolve o catalog_product_id de cada um (/items?ids= multiget) e faz
 * upsert em radar_catalog_products. Cadência semanal (é caro — N anúncios).
 * ON CONFLICT DO NOTHING: não mexe em produtos já na watchlist (ex.: pausados).
 */
export async function collectDiscovery(orgId: string, tok: OrgToken): Promise<DiscoveryResult> {
  const sb = getSupabase()
  const r: DiscoveryResult = { own_items: 0, catalog_found: 0, errors: 0 }

  for (const sellerId of tok.ownSellerIds) {
    try {
      const itemIds = await getOwnItemIds(sellerId, tok)
      r.own_items += itemIds.length

      const refs = await resolveOwnItemsCatalog(itemIds, tok)
      const byCatalog = new Map<string, { categoryId: string | null; title: string | null }>()
      for (const ref of refs) {
        if (ref.catalogProductId) {
          byCatalog.set(ref.catalogProductId, { categoryId: ref.categoryId, title: ref.title })
        }
      }
      r.catalog_found += byCatalog.size

      for (const [catalogId, meta] of byCatalog) {
        const { error } = await sb.from('radar_catalog_products').upsert(
          {
            organization_id: orgId,
            platform: 'mercadolivre',
            catalog_product_id: catalogId,
            category_id: meta.categoryId,
            title: meta.title,
            status: 'ativo',
            origem: 'auto-catalogo-proprio',
          },
          { onConflict: 'organization_id,platform,catalog_product_id', ignoreDuplicates: true },
        )
        if (error) {
          r.errors++
          radarLog('discovery', 'upsert catálogo falhou', catalogId, error.message)
        }
      }
    } catch (e) {
      r.errors++
      radarLog('discovery', 'seller falhou', sellerId, errMsg(e))
    }
  }
  return r
}
