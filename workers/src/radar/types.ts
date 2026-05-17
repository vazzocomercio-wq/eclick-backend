// e-Click Radar IA — tipos compartilhados dos coletores (eclick-workers).

/** Token ML + sellers próprios de uma org — vem do endpoint interno da API. */
export interface OrgTokenData {
  token: string
  ownSellerIds: number[]
}

/** Tipo de rodada de coleta (espelha radar_collection_runs.run_type). */
export type RunType = 'daily' | 'discovery'

/** Item de /products/{catalogId}/items — uma oferta competitiva. */
export interface MlCatalogItem {
  item_id: string
  seller_id: number
  price: number | null
  listing_type_id: string | null
  condition: string | null
  permalink?: string | null
  thumbnail?: string | null
  shipping?: { free_shipping?: boolean; logistic_type?: string | null } | null
}

/** Item próprio resolvido na descoberta (/items?ids= multiget). */
export interface OwnItemCatalogRef {
  itemId: string
  catalogProductId: string | null
  categoryId: string | null
  title: string | null
}

/** Contadores de uma rodada — vão pra radar_collection_runs.stats. */
export interface RunStats {
  orgs: number
  catalog_products: number
  offers_upserted: number
  offers_deactivated: number
  visit_rows: number
  sellers_upserted: number
  errors: number
}
