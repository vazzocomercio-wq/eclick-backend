import { getSupabase } from '../../supabase.js'
import type { OrgToken } from '../token-client.js'
import { getItemVisits, sleep } from '../ml-api.js'
import { radarLog, errMsg } from '../util.js'

export interface CompetitorLinksResult {
  links: number
  own_listings: number
  snapshot_rows: number
  seller_enriched: number
  errors: number
}

/**
 * Coletor de Concorrentes Vinculados (C2).
 *
 * Para cada org com vínculos ativos em radar_competitor_links:
 *  - Lado concorrente: coleta a série diária de visitas do anúncio vinculado
 *    (/items/{id}/visits/time_window — funciona para item de terceiro) e grava
 *    snapshots. O preço vem do que o usuário informou (current_price) — o ML
 *    bloqueia preço de concorrente, spike C0.
 *  - Lado próprio: para cada produto monitorado, coleta visitas dos nossos
 *    anúncios (product_listings) e grava snapshots com link_id NULL.
 *  - Enriquecimento oportunista: se o Radar de catálogo já viu aquele item,
 *    copia o seller para o vínculo (única via de reputação sem o seller_id).
 *
 * Snapshot é upsert idempotente (organization_id,item_id,snapshot_date). O
 * preço só é gravado na linha de HOJE — datas passadas mantêm o preço que
 * tinham (o upsert sem a coluna `price` não a sobrescreve).
 */
export async function collectCompetitorLinks(orgId: string, tok: OrgToken): Promise<CompetitorLinksResult> {
  const sb = getSupabase()
  const r: CompetitorLinksResult = { links: 0, own_listings: 0, snapshot_rows: 0, seller_enriched: 0, errors: 0 }
  const today = new Date().toISOString().slice(0, 10)
  const nowIso = new Date().toISOString()

  const { data: links, error: le } = await sb
    .from('radar_competitor_links')
    .select('id, product_id, competitor_item_id, current_price, price_source, competitor_seller_id')
    .eq('organization_id', orgId)
    .eq('status', 'ativo')
  if (le) throw new Error(`radar_competitor_links read: ${le.message}`)
  if (!links || links.length === 0) return r

  const upsertSnap = async (row: Record<string, unknown>): Promise<void> => {
    const { error } = await sb
      .from('radar_competitor_snapshots')
      .upsert(row, { onConflict: 'organization_id,item_id,snapshot_date' })
    if (error) {
      r.errors++
      radarLog('comp-links', 'snapshot upsert falhou', String(row.item_id), error.message)
    } else {
      r.snapshot_rows++
    }
  }

  /** Grava a série de visitas de um anúncio; preço só na linha de hoje. */
  const collectItem = async (
    itemId: string,
    productId: string,
    linkId: string | null,
    price: number | null,
    priceSource: string | null,
  ): Promise<void> => {
    const series = await getItemVisits(itemId, tok)
    let hasToday = false
    for (const day of series) {
      const visitDate = day.date.slice(0, 10)
      if (visitDate === today) hasToday = true
      const row: Record<string, unknown> = {
        organization_id: orgId,
        product_id: productId,
        link_id: linkId,
        item_id: itemId,
        snapshot_date: visitDate,
        visits: day.total ?? 0,
        collected_at: nowIso,
      }
      if (visitDate === today) {
        row.price = price
        row.price_source = priceSource
      }
      await upsertSnap(row)
    }
    // Garante a linha de hoje com o preço, mesmo que a janela não traga hoje.
    if (!hasToday) {
      await upsertSnap({
        organization_id: orgId,
        product_id: productId,
        link_id: linkId,
        item_id: itemId,
        snapshot_date: today,
        price,
        price_source: priceSource,
        collected_at: nowIso,
      })
    }
  }

  // ── 1. Lado concorrente ────────────────────────────────────────────────────
  for (const link of links) {
    r.links++
    const itemId = link.competitor_item_id as string
    const productId = link.product_id as string

    // Enriquecimento oportunista de seller — só se ainda não temos e o Radar
    // de catálogo já coletou esse mesmo item (lá o seller_id vem de graça).
    if (link.competitor_seller_id == null) {
      try {
        const { data: known } = await sb
          .from('radar_offers')
          .select('seller_ref, seller:seller_ref(seller_id)')
          .eq('organization_id', orgId)
          .eq('item_id', itemId)
          .limit(1)
          .maybeSingle()
        const sellerRel = known?.seller as { seller_id?: number } | Array<{ seller_id?: number }> | null
        const seller = Array.isArray(sellerRel) ? sellerRel[0] : sellerRel
        if (known?.seller_ref && seller?.seller_id != null) {
          await sb
            .from('radar_competitor_links')
            .update({
              competitor_seller_ref: known.seller_ref,
              competitor_seller_id: seller.seller_id,
              updated_at: nowIso,
            })
            .eq('id', link.id)
          r.seller_enriched++
        }
      } catch (e) {
        radarLog('comp-links', 'cross-ref seller falhou', itemId, errMsg(e))
      }
    }

    try {
      await collectItem(
        itemId,
        productId,
        link.id as string,
        (link.current_price as number | null) ?? null,
        (link.price_source as string | null) ?? 'manual',
      )
      await sleep(150)
    } catch (e) {
      r.errors++
      radarLog('comp-links', 'concorrente falhou', itemId, errMsg(e))
    }
  }

  // ── 2. Lado próprio — anúncios ML dos produtos monitorados ──────────────────
  const productIds = [...new Set(links.map((l) => l.product_id as string))]
  const { data: listings, error: lstErr } = await sb
    .from('product_listings')
    .select('product_id, listing_id, listing_price')
    .in('product_id', productIds)
    .eq('platform', 'mercadolivre')
    .eq('is_active', true)
  if (lstErr) {
    radarLog('comp-links', 'product_listings read falhou', lstErr.message)
  }
  for (const lst of listings ?? []) {
    const itemId = lst.listing_id as string | null
    if (!itemId) continue
    r.own_listings++
    try {
      await collectItem(
        itemId,
        lst.product_id as string,
        null,
        (lst.listing_price as number | null) ?? null,
        'api',
      )
      await sleep(150)
    } catch (e) {
      r.errors++
      radarLog('comp-links', 'nosso anuncio falhou', itemId, errMsg(e))
    }
  }

  return r
}
