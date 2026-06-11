/** Multiplicação de Anúncios — tipos.
 *
 *  O multiplier é uma camada FINA em cima dos publicadores existentes
 *  (ShopeeCreativePublisher.publish, TikTokShopService.publishProduct,
 *  ProductsService.setStorefrontVisibility). Ele NÃO fala com APIs de
 *  marketplace — só monta a proposta (payload) a partir do produto canônico
 *  + conteúdo do anúncio de origem, guarda na fila revisável
 *  (multiplier_drafts) e despacha pro publicador do destino. */

/** Destinos suportados. Mercado Livre publica direto (POST /items) com
 *  categoria prevista + atributos obrigatórios preenchidos (determinístico +
 *  IA), nascendo PAUSADO pra revisão no painel ML. */
export const MULTIPLIER_TARGETS = ['shopee', 'tiktok_shop', 'storefront', 'mercadolivre'] as const
export type MultiplierTarget = typeof MULTIPLIER_TARGETS[number]

/** Conteúdo proposto pro canal destino — tudo revisável na fila antes do
 *  publish. Campos não usados por um destino são simplesmente ignorados. */
export interface MultiplierPayload {
  title:        string
  description:  string | null
  price:        number | null
  image_urls:   string[]
  sku:          string | null
  brand:        string | null
  weight_kg:    number | null
  package_dimensions_cm: { length: number; width: number; height: number } | null
  /** Estoque inicial (TikTok usa na criação; depois o motor central assume). */
  stock:        number | null
  /** Categoria do DESTINO (TikTok/ML: id recomendado/escolhido). */
  category_id?: string | null
  /** GTIN/EAN do produto (ML usa no atributo GTIN). */
  gtin?:        string | null
  /** Tipo de anúncio ML: 'free' | 'gold_special' | 'gold_pro'. */
  listing_type?: string | null
  /** Condição ML: 'new' | 'used'. */
  condition?:   string | null
}

export interface MultiplierDraft {
  id:                string
  organization_id:   string
  product_id:        string
  source_platform:   string | null
  source_listing_id: string | null
  target_platform:   MultiplierTarget | 'mercadolivre'
  target_account_id: string | null
  payload:           MultiplierPayload
  status:            'draft' | 'publishing' | 'published' | 'failed' | 'discarded'
  error_message:     string | null
  external_id:       string | null
  created_by:        string | null
  created_at:        string
  updated_at:        string
  published_at:      string | null
}

/** Linha da lista de candidatos: produto com anúncio em ≥1 canal e SEM
 *  anúncio no destino escolhido. */
export interface MultiplierCandidate {
  product_id:  string
  name:        string
  sku:         string | null
  price:       number | null
  stock:       number | null
  photo_count: number
  thumbnail:   string | null
  /** canais onde o produto JÁ tem anúncio ativo (platform:account). */
  covered:     string[]
  /** pendências que impedem/atrapalham publicar no destino (PT-BR). */
  warnings:    string[]
}
