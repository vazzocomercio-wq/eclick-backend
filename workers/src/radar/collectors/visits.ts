import { getSupabase } from '../../supabase.js'
import type { OrgToken } from '../token-client.js'
import { getItemVisits, sleep } from '../ml-api.js'
import { radarLog, errMsg } from '../util.js'

export interface VisitsResult {
  items: number
  visit_rows: number
  errors: number
}

/**
 * Coletor de visitas — para cada anúncio ativo em radar_offers (próprio ou
 * concorrente), busca a série diária (/items/{id}/visits/time_window) e faz
 * upsert idempotente em radar_visit_snapshots. 1 chamada por item.
 */
export async function collectVisits(orgId: string, tok: OrgToken): Promise<VisitsResult> {
  const sb = getSupabase()
  const r: VisitsResult = { items: 0, visit_rows: 0, errors: 0 }

  const { data: offers, error } = await sb
    .from('radar_offers')
    .select('item_id, catalog_product_ref')
    .eq('organization_id', orgId)
    .eq('status', 'ativo')
  if (error) throw new Error(`radar_offers read: ${error.message}`)

  const seen = new Set<string>()
  for (const offer of offers ?? []) {
    const itemId = offer.item_id as string
    if (seen.has(itemId)) continue
    seen.add(itemId)
    r.items++

    try {
      const series = await getItemVisits(itemId, tok)
      for (const day of series) {
        const visitDate = day.date.slice(0, 10) // YYYY-MM-DD
        const { error: upErr } = await sb.from('radar_visit_snapshots').upsert(
          {
            organization_id: orgId,
            catalog_product_ref: offer.catalog_product_ref,
            item_id: itemId,
            visit_date: visitDate,
            visits: day.total ?? 0,
            collected_at: new Date().toISOString(),
          },
          { onConflict: 'organization_id,item_id,visit_date' },
        )
        if (upErr) {
          r.errors++
          radarLog('visits', 'upsert falhou', itemId, visitDate, upErr.message)
        } else {
          r.visit_rows++
        }
      }
      await sleep(150)
    } catch (e) {
      r.errors++
      radarLog('visits', 'item falhou', itemId, errMsg(e))
    }
  }
  return r
}
