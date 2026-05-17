import type { OrgToken } from './token-client.js'
import type { MlCatalogItem, OwnItemCatalogRef } from './types.js'

const ML_BASE = 'https://api.mercadolibre.com'

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * GET autenticado no ML. Em 401, faz `tok.refresh()` e tenta 1× de novo —
 * cobre token expirando no meio de uma rodada longa.
 */
async function mlGet<T>(path: string, tok: OrgToken): Promise<T> {
  const doFetch = (): Promise<Response> =>
    fetch(`${ML_BASE}${path}`, { headers: { Authorization: `Bearer ${tok.token}` } })

  let res = await doFetch()
  if (res.status === 401) {
    await tok.refresh()
    res = await doFetch()
  }
  if (!res.ok) {
    throw new Error(`ML GET ${path} → HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

/** /products/{catalogId}/items — conjunto competitivo do produto de catálogo. */
export async function getCatalogOffers(
  catalogProductId: string,
  tok: OrgToken,
): Promise<MlCatalogItem[]> {
  const body = await mlGet<{ results?: MlCatalogItem[] }>(
    `/products/${catalogProductId}/items`,
    tok,
  )
  return body.results ?? []
}

/** /items/{id}/visits/time_window — série diária de visitas. */
export async function getItemVisits(
  itemId: string,
  tok: OrgToken,
  days = 30,
): Promise<Array<{ date: string; total: number }>> {
  const body = await mlGet<{ results?: Array<{ date: string; total: number }> }>(
    `/items/${itemId}/visits/time_window?last=${days}&unit=day`,
    tok,
  )
  return body.results ?? []
}

/** /users/{id} — perfil + reputação do vendedor. */
export async function getUser(sellerId: number, tok: OrgToken): Promise<Record<string, unknown>> {
  return mlGet<Record<string, unknown>>(`/users/${sellerId}`, tok)
}

export interface PriceToWin {
  price_to_win: number | null
  status: string | null          // winning | competing | sharing_first_place | listed
  winner_price: number | null
}

/**
 * /items/{id}/price_to_win — status real do catálogo + preço pra ganhar.
 * Só responde p/ item PRÓPRIO da conta do token; item de outra conta (multi-
 * conta) ou de terceiro dá 403 → retorna null (degradação silenciosa).
 */
export async function getPriceToWin(itemId: string, tok: OrgToken): Promise<PriceToWin | null> {
  try {
    const body = await mlGet<{
      price_to_win?: number
      status?: string
      winner?: { price?: number }
    }>(`/items/${itemId}/price_to_win?version=v2`, tok)
    return {
      price_to_win: typeof body.price_to_win === 'number' ? body.price_to_win : null,
      status: body.status ?? null,
      winner_price: typeof body.winner?.price === 'number' ? body.winner.price : null,
    }
  } catch {
    return null
  }
}

/** /items/{id} — detalhe de um item PRÓPRIO (sold/available_quantity). */
export async function getItem(itemId: string, tok: OrgToken): Promise<Record<string, unknown>> {
  return mlGet<Record<string, unknown>>(`/items/${itemId}`, tok)
}

/** /users/{sellerId}/items/search — ids dos anúncios próprios (paginado, teto ~1000). */
export async function getOwnItemIds(sellerId: number, tok: OrgToken): Promise<string[]> {
  const ids: string[] = []
  const limit = 50
  let offset = 0
  for (;;) {
    const page = await mlGet<{ results?: string[]; paging?: { total?: number } }>(
      `/users/${sellerId}/items/search?offset=${offset}&limit=${limit}`,
      tok,
    )
    const batch = page.results ?? []
    ids.push(...batch)
    offset += limit
    const total = page.paging?.total ?? ids.length
    if (batch.length === 0 || offset >= total || offset >= 1000) break
    await sleep(150)
  }
  return ids
}

/** /items?ids= — multiget de itens próprios (20 ids/call), resolve catalog_product_id. */
export async function resolveOwnItemsCatalog(
  itemIds: string[],
  tok: OrgToken,
): Promise<OwnItemCatalogRef[]> {
  const out: OwnItemCatalogRef[] = []
  for (let i = 0; i < itemIds.length; i += 20) {
    const slice = itemIds.slice(i, i + 20)
    const rows = await mlGet<
      Array<{
        code: number
        body?: { id?: string; catalog_product_id?: string | null; category_id?: string | null; title?: string | null }
      }>
    >(`/items?ids=${slice.join(',')}&attributes=id,catalog_product_id,category_id,title`, tok)
    for (const row of rows) {
      if (row.code === 200 && row.body?.id) {
        out.push({
          itemId: row.body.id,
          catalogProductId: row.body.catalog_product_id ?? null,
          categoryId: row.body.category_id ?? null,
          title: row.body.title ?? null,
        })
      }
    }
    await sleep(150)
  }
  return out
}
