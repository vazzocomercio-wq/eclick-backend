/** Onda 3 / S2 — tipos do Social Commerce. */

export type SocialCommerceChannel =
  | 'instagram_shop'
  | 'facebook_shop'
  | 'tiktok_shop'
  | 'google_shopping'
  | 'whatsapp_business'

export type ChannelStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'paused'

export type ProductSyncStatus =
  | 'pending'
  | 'syncing'
  | 'synced'
  | 'error'
  | 'rejected'
  | 'paused'

export interface SocialCommerceChannelRow {
  id:                  string
  organization_id:     string
  channel:             SocialCommerceChannel
  access_token:        string | null
  refresh_token:       string | null
  token_expires_at:    string | null
  external_account_id: string | null
  external_catalog_id: string | null
  external_pixel_id:   string | null
  config:              Record<string, unknown>
  status:              ChannelStatus
  last_sync_at:        string | null
  last_sync_status:    string | null
  last_error:          string | null
  products_synced:     number
  sync_errors:         number
  created_at:          string
  updated_at:          string
}

export interface SocialCommerceProductRow {
  id:                   string
  channel_id:           string
  product_id:           string
  organization_id:      string
  external_product_id:  string | null
  external_product_url: string | null
  sync_status:          ProductSyncStatus
  last_synced_at:       string | null
  last_error:           string | null
  rejection_reason:     string | null
  synced_data:          Record<string, unknown>
  metrics:              Record<string, unknown>
  created_at:           string
  updated_at:           string
}

/** Shape pra mapear produto ao formato do Meta Catalog API.
 *  `item_type` NAO vai aqui — eh top-level do batch request. */
export interface MetaProductData {
  title:                 string
  description:           string
  availability:          'in stock' | 'out of stock'
  condition:             'new' | 'refurbished' | 'used'
  price:                 string  // "49.90 BRL"
  link:                  string
  image_link:            string
  additional_image_link?: string[]
  brand?:                string
  gtin?:                 string
  custom_label_0?:       string
  custom_label_1?:       string
  /** Tira ou devolve o item da loja do Instagram/WhatsApp.
   *
   *  'active'   -> aparece (o campo `visibility` passa a ler 'published')
   *  'archived' -> some da loja       (`visibility` passa a ler 'hidden')
   *
   *  🔴 O campo se chama `status`, NAO `visibility`. A Meta renomeou, e o
   *  `visibility` antigo so aceita 'published'/'hidden' na LEITURA. Mandar
   *  `visibility: 'staging'` na escrita e o pior caso possivel: a API
   *  responde 200, grava a string, e nao esconde nada — a gente achou que
   *  tinha tirado 265 produtos da loja e eles seguiram a venda por um dia
   *  (23-24/08/2026). Se for mudar, teste lendo de volta: tem que virar
   *  'hidden', nao o que voce escreveu.
   *
   *  Sempre mandar explicito no sync: sem isso, produto que voltou pra
   *  vitrine continuaria arquivado. */
  status?:               'active' | 'archived'
}

/** Item que saiu da vitrine mas continua publicado no catalogo da Meta. */
export interface CatalogOrphan {
  product_id:  string
  retailer_id: string
  name:        string
  sku:         string | null
  price:       number | null
  stock:       number | null
}
