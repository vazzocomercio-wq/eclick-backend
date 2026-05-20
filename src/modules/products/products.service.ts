import { Injectable, NotFoundException, HttpException, BadRequestException, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { StockService } from '../stock/stock.service'
import { SocialCommerceService } from '../social-commerce/social-commerce.service'

const PRODUCT_FIELDS = `id,name,sku,brand,price,stock,status,platforms,photo_urls,
  ml_title,condition,category,created_at,
  wholesale_enabled,wholesale_levels,ml_listing_type,
  ml_free_shipping,ml_flex,ml_item_id,ml_listing_id,ml_permalink,cost_price,tax_percentage,tax_on_freight,
  storefront_visible`

export interface UpdateProductCostsDto {
  cost_price?:    number | null
  tax_percentage?: number | null
  tax_on_freight?: boolean
}

export interface CreateVinculoDto {
  product_id:           string
  platform?:            string
  listing_id:           string
  quantity_per_unit?:   number
  variation_id?:        string | null
  variation_attributes?: Record<string, unknown> | null
  account_id?:          string | null
  listing_title?:       string | null
  listing_price?:       number | null
  listing_thumbnail?:   string | null
  listing_permalink?:   string | null
}

export interface CreateStockMovementDto {
  product_id:       string
  product_stock_id?: string
  type:             'in' | 'out' | 'adjustment' | 'sale' | 'return' | 'transfer'
  quantity:         number
  reason?:          string | null
}

export interface UpdateStockDto {
  quantity?:            number
  virtual_quantity?:    number
  min_stock_to_pause?:  number
  auto_pause_enabled?:  boolean
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name)

  constructor(
    private readonly stock: StockService,
    private readonly socialCommerce: SocialCommerceService,
  ) {}

  /**
   * Loja Propria — Fase 9: marca/desmarca produtos pra aparecer na vitrine.
   * Ao publicar (visible=true), pula produtos sem nome ou sem preco — senao
   * a loja renderiza produto quebrado. Retorna quantos foram e quantos pularam.
   */
  async setStorefrontVisibility(
    orgId: string,
    productIds: string[],
    visible: boolean,
  ): Promise<{ updated: number; skipped: number }> {
    const ids = Array.isArray(productIds) ? productIds.filter(Boolean) : []
    if (ids.length === 0) throw new BadRequestException('Selecione ao menos um produto.')

    let targetIds = ids
    let skipped = 0
    if (visible) {
      const { data: valid, error: selErr } = await supabaseAdmin
        .from('products')
        .select('id')
        .eq('organization_id', orgId)
        .in('id', ids)
        .not('name', 'is', null)
        .neq('name', '')
        .gt('price', 0)
      if (selErr) throw new BadRequestException(`Erro: ${selErr.message}`)
      targetIds = (valid ?? []).map(r => r.id as string)
      skipped = ids.length - targetIds.length
    }
    if (targetIds.length === 0) return { updated: 0, skipped }

    const { error } = await supabaseAdmin
      .from('products')
      .update({ storefront_visible: visible, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .in('id', targetIds)
    if (error) throw new BadRequestException(`Erro ao atualizar: ${error.message}`)

    // Loja Propria + Catalogo Meta/WhatsApp: ao publicar produtos na vitrine
    // (visible=true), tentamos sincronizar pro Meta Catalog automaticamente.
    // Best-effort: se a org nao tem canal conectado, `tryAutoSyncProducts`
    // retorna { skipped:true } silenciosamente. Fire-and-forget pra nao
    // bloquear o response — o lojista nao precisa esperar a IA do Meta
    // confirmar o sync. Erros vao pro log.
    if (visible && targetIds.length > 0) {
      this.socialCommerce.tryAutoSyncProducts(orgId, targetIds)
        .then(r => {
          if (!r.skipped) {
            this.logger.log(
              `[auto-sync] org=${orgId.slice(0,8)} produtos=${targetIds.length} synced=${r.synced} failed=${r.failed}`,
            )
          }
        })
        .catch(e => this.logger.warn(`[auto-sync] org=${orgId.slice(0,8)}: ${(e as Error).message}`))
    }

    return { updated: targetIds.length, skipped }
  }

  async getAll(orgId: string | null) {
    // Supabase/PostgREST corta em 1000 rows por request. Catálogos grandes
    // (2k+ produtos) ficavam truncados — produtos além do top-1000 sumiam da
    // listagem (e da busca client-side). Pagina via .range() até esgotar.
    const PAGE = 1000
    const all: Record<string, unknown>[] = []
    for (let offset = 0; ; offset += PAGE) {
      let query = supabaseAdmin
        .from('products')
        .select(PRODUCT_FIELDS)
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE - 1)
      // When no org membership, return all products (user is likely sole owner)
      if (orgId) query = query.eq('organization_id', orgId)
      const { data, error } = await query
      if (error) throw new Error(error.message)
      const batch = data ?? []
      all.push(...(batch as Record<string, unknown>[]))
      if (batch.length < PAGE) break
    }
    return all
  }

  // ── Imposto padrão da organização (cadastro central) ──────────────────────

  /** Lê o imposto padrão central da org. */
  async getTaxConfig(orgId: string): Promise<{
    default_tax_percentage: number | null
    default_tax_on_freight: boolean
  }> {
    const { data, error } = await supabaseAdmin
      .from('organizations')
      .select('default_tax_percentage, default_tax_on_freight')
      .eq('id', orgId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    const row = data as { default_tax_percentage: number | null; default_tax_on_freight: boolean | null } | null
    return {
      default_tax_percentage: row?.default_tax_percentage ?? null,
      default_tax_on_freight: Boolean(row?.default_tax_on_freight),
    }
  }

  /**
   * Salva o imposto padrão central e, conforme `apply`, propaga pros produtos:
   *   - 'all'        → sobrescreve tax_percentage de TODOS os produtos da org
   *   - 'only_empty' → preenche só os produtos sem tax_percentage (NULL)
   *   - 'none'       → só salva o padrão; produtos sem imposto herdam no cálculo
   */
  async updateTaxConfig(orgId: string, dto: {
    tax_percentage: number | null
    tax_on_freight: boolean
    apply: 'none' | 'all' | 'only_empty'
  }): Promise<{ default_tax_percentage: number | null; default_tax_on_freight: boolean; products_updated: number }> {
    const { error: orgErr } = await supabaseAdmin
      .from('organizations')
      .update({
        default_tax_percentage: dto.tax_percentage,
        default_tax_on_freight: dto.tax_on_freight,
      })
      .eq('id', orgId)
    if (orgErr) throw new Error(`updateTaxConfig.org: ${orgErr.message}`)

    let productsUpdated = 0
    if (dto.apply !== 'none') {
      let q = supabaseAdmin
        .from('products')
        .update({
          tax_percentage: dto.tax_percentage,
          tax_on_freight: dto.tax_on_freight,
          updated_at:     new Date().toISOString(),
        }, { count: 'exact' })
        .eq('organization_id', orgId)
      if (dto.apply === 'only_empty') q = q.is('tax_percentage', null)
      const { count, error } = await q
      if (error) throw new Error(`updateTaxConfig.products: ${error.message}`)
      productsUpdated = count ?? 0
    }

    return {
      default_tax_percentage: dto.tax_percentage,
      default_tax_on_freight: dto.tax_on_freight,
      products_updated:       productsUpdated,
    }
  }

  /** Server-side pagination + filtering pra DataTable view do /produtos.
   * quick_filter: 'all'|'active'|'paused'|'no_stock'|'critical'|'stock_high'|
   *               'in_ads'|'no_ads'|'cadastro_pendente'
   * stock_min/stock_max: range numérico (independente do quick_filter).
   * Útil pra priorizar cadastro de produtos com estoque grande primeiro. */
  async listPaginated(orgId: string | null, opts: {
    page?:        number
    per_page?:    number
    search?:      string
    quick_filter?: string
    sort_by?:     string
    sort_dir?:    'asc' | 'desc'
    stock_min?:   number
    stock_max?:   number
  }): Promise<{ data: unknown[]; total: number; page: number; per_page: number }> {
    const page    = Math.max(opts.page ?? 1, 1)
    const perPage = Math.min(Math.max(opts.per_page ?? 25, 1), 200)
    const offset  = (page - 1) * perPage
    // Whitelist de colunas sort-by pra evitar SQL injection via PostgREST
    const SORTABLE = new Set(['created_at', 'updated_at', 'name', 'sku', 'stock', 'price', 'my_price', 'cost_price'])
    const sortBy  = opts.sort_by && SORTABLE.has(opts.sort_by) ? opts.sort_by : 'created_at'
    const ascending = opts.sort_dir === 'asc'

    // Set de listings em campanha ativa pra os filtros in_ads / no_ads
    let adsListingIds: Set<string> | null = null
    if (opts.quick_filter === 'in_ads' || opts.quick_filter === 'no_ads') {
      adsListingIds = await this.getActiveAdsListingIds(orgId)
    }

    let q = supabaseAdmin
      .from('products')
      .select(PRODUCT_FIELDS, { count: 'exact' })
      .order(sortBy, { ascending })
      .range(offset, offset + perPage - 1)
    if (orgId) q = q.eq('organization_id', orgId)

    if (opts.search?.trim()) {
      const s = opts.search.trim().replace(/%/g, '')
      q = q.or(`name.ilike.%${s}%,sku.ilike.%${s}%,brand.ilike.%${s}%`)
    }
    switch (opts.quick_filter) {
      case 'active':   q = q.eq('status', 'active'); break
      case 'paused':   q = q.eq('status', 'paused'); break
      case 'no_stock': q = q.or('stock.eq.0,stock.is.null'); break
      case 'critical': q = q.gt('stock', 0).lte('stock', 5); break
      case 'stock_high':
        // 2026-05-14: estoque alto (>10). Útil pra priorizar cadastro de
        // produtos que já têm volume — completam-se primeiro pra virar venda.
        q = q.gt('stock', 10)
        break
      case 'incomplete':
      case 'cadastro_pendente':
        // F2/F3 (2026-05-14): produtos com tag cadastro_pendente OU catalog_status='incomplete'
        q = q.or('catalog_status.eq.incomplete,tags.cs.{cadastro_pendente}')
        break
      case 'in_ads':
        if (adsListingIds && adsListingIds.size > 0) q = q.in('ml_listing_id', [...adsListingIds])
        else                                          q = q.eq('id', '00000000-0000-0000-0000-000000000000') // forces empty
        break
      case 'no_ads':
        if (adsListingIds && adsListingIds.size > 0) q = q.or(`ml_listing_id.is.null,ml_listing_id.not.in.(${[...adsListingIds].join(',')})`)
        // se sem campanhas ativas, todos sem ads → sem filtro adicional
        break
    }

    // Range numérico de estoque — combina com quick_filter (ex: cadastro_pendente + stock>50)
    if (opts.stock_min != null && Number.isFinite(opts.stock_min)) {
      q = q.gte('stock', opts.stock_min)
    }
    if (opts.stock_max != null && Number.isFinite(opts.stock_max)) {
      q = q.lte('stock', opts.stock_max)
    }

    const { data, count, error } = await q
    if (error) throw new Error(error.message)
    return { data: data ?? [], total: count ?? 0, page, per_page: perPage }
  }

  /** KPIs do catálogo — alimenta o painel "Catálogo" em /produtos. */
  async getKpis(orgId: string | null): Promise<{ active: number; no_stock: number; critical: number; no_ads: number }> {
    const buildBase = () => {
      const q = supabaseAdmin.from('products').select('id', { count: 'exact', head: true })
      return orgId ? q.eq('organization_id', orgId) : q
    }

    const [activeRes, noStockRes, criticalRes, allListingsRes, adsIds] = await Promise.all([
      buildBase().eq('status', 'active'),
      buildBase().or('stock.eq.0,stock.is.null'),
      buildBase().gt('stock', 0).lte('stock', 5),
      (orgId
        ? supabaseAdmin.from('products').select('ml_listing_id').eq('organization_id', orgId).not('ml_listing_id', 'is', null)
        : supabaseAdmin.from('products').select('ml_listing_id').not('ml_listing_id', 'is', null)
      ),
      this.getActiveAdsListingIds(orgId),
    ])

    const allListings = ((allListingsRes.data ?? []) as Array<{ ml_listing_id: string | null }>)
      .map(r => r.ml_listing_id)
      .filter((id): id is string => !!id)
    const noAds = allListings.filter(id => !adsIds.has(id)).length

    return {
      active:   activeRes.count   ?? 0,
      no_stock: noStockRes.count  ?? 0,
      critical: criticalRes.count ?? 0,
      no_ads:   noAds,
    }
  }

  /** Set de ml_listing_id que estão em ml_ads_campaigns ativas da org. */
  private async getActiveAdsListingIds(orgId: string | null): Promise<Set<string>> {
    let q = supabaseAdmin
      .from('ml_ads_campaigns')
      .select('items')
      .eq('status', 'active')
    if (orgId) q = q.eq('organization_id', orgId)
    const { data } = await q
    const out = new Set<string>()
    for (const c of (data ?? []) as Array<{ items?: string[] | null }>) {
      for (const id of (c.items ?? [])) if (typeof id === 'string') out.add(id)
    }
    return out
  }

  async getLinkedListingIds(): Promise<string[]> {
    const { data } = await supabaseAdmin
      .from('products')
      .select('ml_listing_id')
      .not('ml_listing_id', 'is', null)
    return (data ?? []).map((r: any) => r.ml_listing_id as string)
  }

  async getById(id: string) {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('id', id)
      .single()
    if (error || !data) throw new NotFoundException('Produto não encontrado')
    return data
  }

  async updateFull(id: string, payload: Record<string, unknown>) {
    const { data, error } = await supabaseAdmin
      .from('products')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')
      .single()
    if (error || !data) throw new NotFoundException('Produto não encontrado')
    return data
  }

  async updateCosts(orgId: string | null, productId: string, dto: UpdateProductCostsDto) {
    let query = supabaseAdmin
      .from('products')
      .update({
        cost_price:     dto.cost_price     ?? null,
        tax_percentage: dto.tax_percentage ?? null,
        tax_on_freight: dto.tax_on_freight ?? false,
        updated_at:     new Date().toISOString(),
      })
      .eq('id', productId)

    // Só filtra por org quando orgId está presente — produtos criados sem org têm organization_id null
    if (orgId) query = (query as any).eq('organization_id', orgId)

    const { data, error } = await (query as any)
      .select('id, cost_price, tax_percentage, tax_on_freight')
      .single()

    if (error || !data) throw new NotFoundException('Produto não encontrado')
    return data
  }

  async deleteProduct(id: string) {
    const { error } = await supabaseAdmin
      .from('products')
      .delete()
      .eq('id', id)
    if (error) throw new Error(error.message)
  }

  /** Atualização em massa por SKU. Cada row tem { sku, cost_price?,
   *  tax_percentage? }. Match por SKU exato dentro da org. Retorna
   *  contagens e lista de SKUs não-encontrados / com erro. */
  async bulkUpdateCostsBySku(
    orgId: string | null,
    rows: Array<{ sku: string; cost_price?: number | null; tax_percentage?: number | null; tax_on_freight?: boolean }>,
  ): Promise<{
    updated:    number
    not_found:  number
    errors:     number
    not_found_skus: string[]
    error_details:  Array<{ sku: string; reason: string }>
  }> {
    let updated = 0
    let notFound = 0
    let errors = 0
    const notFoundSkus: string[] = []
    const errorDetails: Array<{ sku: string; reason: string }> = []

    // Carrega todos os products dessa org de uma vez pra match local —
    // bem mais rápido do que 1 query por SKU.
    let baseQuery = supabaseAdmin
      .from('products')
      .select('id, sku')
      .not('sku', 'is', null)
      .neq('sku', '')
    if (orgId) baseQuery = (baseQuery as any).eq('organization_id', orgId)

    const { data: existingProducts, error: loadErr } = await baseQuery
    if (loadErr) {
      throw new Error(`Erro ao carregar catálogo: ${loadErr.message}`)
    }

    const skuToId = new Map<string, string>()
    for (const p of (existingProducts ?? []) as Array<{ id: string; sku: string }>) {
      if (!p.sku) continue
      // Normaliza SKU pra match case-insensitive
      skuToId.set(p.sku.trim().toUpperCase(), p.id)
    }

    // Aplica updates em lote (1 por row) — sequencial pra coletar erros
    for (const row of rows) {
      const skuRaw = (row.sku ?? '').trim()
      if (!skuRaw) {
        errors++
        errorDetails.push({ sku: skuRaw || '(vazio)', reason: 'SKU vazio' })
        continue
      }
      const skuKey = skuRaw.toUpperCase()
      const productId = skuToId.get(skuKey)
      if (!productId) {
        notFound++
        notFoundSkus.push(skuRaw)
        continue
      }

      // Validação simples
      if (row.cost_price != null && (row.cost_price < 0 || !isFinite(row.cost_price))) {
        errors++
        errorDetails.push({ sku: skuRaw, reason: `cost_price inválido: ${row.cost_price}` })
        continue
      }
      if (row.tax_percentage != null && (row.tax_percentage < 0 || row.tax_percentage > 100 || !isFinite(row.tax_percentage))) {
        errors++
        errorDetails.push({ sku: skuRaw, reason: `tax_percentage inválido (deve ser 0-100): ${row.tax_percentage}` })
        continue
      }

      // Monta patch: só atualiza campos que vieram (≠ undefined). null
      // explícito é permitido pra LIMPAR um valor.
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (row.cost_price     !== undefined) patch.cost_price     = row.cost_price
      if (row.tax_percentage !== undefined) patch.tax_percentage = row.tax_percentage
      if (row.tax_on_freight !== undefined) patch.tax_on_freight = row.tax_on_freight

      const { error: updErr } = await supabaseAdmin
        .from('products')
        .update(patch)
        .eq('id', productId)
      if (updErr) {
        errors++
        errorDetails.push({ sku: skuRaw, reason: updErr.message })
      } else {
        updated++
      }
    }

    return {
      updated,
      not_found:      notFound,
      errors,
      not_found_skus: notFoundSkus.slice(0, 50),  // limita pra não estourar payload
      error_details:  errorDetails.slice(0, 50),
    }
  }

  async deleteMany(ids: string[]) {
    const { error } = await supabaseAdmin
      .from('products')
      .delete()
      .in('id', ids)
    if (error) throw new Error(error.message)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async createVinculo(dto: any) {
    const { data, error } = await supabaseAdmin
      .from('product_listings')
      .insert({
        product_id:           dto.product_id,
        platform:             dto.platform          ?? 'mercadolivre',
        listing_id:           dto.listing_id,
        quantity_per_unit:    dto.quantity_per_unit ?? 1,
        variation_id:         dto.variation_id      ?? null,
        variation_attributes: dto.variation_attributes ?? null,
        account_id:           dto.account_id        ?? null,
        listing_title:        dto.listing_title     ?? null,
        listing_price:        dto.listing_price     ?? null,
        listing_thumbnail:    dto.listing_thumbnail ?? null,
        listing_permalink:    dto.listing_permalink ?? null,
        is_active:            true,
      })
      .select()
      .single()
    if (error) {
      console.error('[vinculos.service] erro Supabase:', JSON.stringify(error))
      throw new Error(error.message)
    }
    return data
  }

  async deleteVinculo(id: string) {
    const { error } = await supabaseAdmin
      .from('product_listings')
      .delete()
      .eq('id', id)
    if (error) throw new Error(error.message)
  }

  /** Cria N vínculos do MESMO product_id pra N listings em batch. Cada
   *  listing pode pertencer a uma conta ML diferente (account_id) — o
   *  caller passa esse campo por listing. Idempotente: se já existe um
   *  vínculo (product_id + listing_id + platform) ele é marcado como
   *  `skipped` em vez de duplicar. Usado pela tela
   *  /catalogo/anuncios/mercadolivre no fluxo "selecionar vários → vincular
   *  todos a um produto". */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async createVinculosBulk(dto: any): Promise<{
    created: number
    skipped: number
    errors:  number
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    results: Array<{ listing_id: string; status: 'created' | 'skipped' | 'error'; message?: string }>
  }> {
    const productId: string = String(dto?.product_id ?? '')
    const platform:  string = String(dto?.platform ?? 'mercadolivre')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: Array<any> = Array.isArray(dto?.items) ? dto.items : []
    if (!productId || items.length === 0) {
      throw new Error('product_id e items são obrigatórios')
    }

    const listingIds = items.map(it => String(it?.listing_id ?? '')).filter(Boolean)
    if (listingIds.length === 0) {
      throw new Error('items[].listing_id obrigatório')
    }

    // 1. Pega vínculos JÁ existentes pra esse product_id + plataforma —
    //    permite skip idempotente em vez de erro de unique constraint.
    const { data: existing } = await supabaseAdmin
      .from('product_listings')
      .select('listing_id')
      .eq('platform', platform)
      .in('listing_id', listingIds)

    const existingIds = new Set(((existing ?? []) as Array<{ listing_id: string }>).map(r => r.listing_id))

    // 2. Monta rows pra inserir — pula os já existentes
    const toInsert: Record<string, unknown>[] = []
    const results: Array<{ listing_id: string; status: 'created' | 'skipped' | 'error'; message?: string }> = []
    let skipped = 0
    for (const it of items) {
      const listingId = String(it?.listing_id ?? '')
      if (!listingId) continue
      if (existingIds.has(listingId)) {
        skipped++
        results.push({ listing_id: listingId, status: 'skipped', message: 'já vinculado' })
        continue
      }
      toInsert.push({
        product_id:           productId,
        platform,
        listing_id:           listingId,
        quantity_per_unit:    Number(it?.quantity_per_unit ?? 1),
        variation_id:         it?.variation_id      ?? null,
        variation_attributes: it?.variation_attributes ?? null,
        // account_id armazena o seller_id ML como text — chave de multi-conta
        account_id:           it?.account_id        ?? null,
        listing_title:        it?.listing_title     ?? null,
        listing_price:        it?.listing_price     ?? null,
        listing_thumbnail:    it?.listing_thumbnail ?? null,
        listing_permalink:    it?.listing_permalink ?? null,
        is_active:            true,
      })
    }

    if (toInsert.length === 0) {
      return { created: 0, skipped, errors: 0, results }
    }

    // 3. Insert em batch único — best-effort. Se algum row falhar (ex:
    //    unique constraint race), cai pro fallback per-row pra capturar
    //    erros individuais sem perder os que poderiam ter dado certo.
    const { data: inserted, error } = await supabaseAdmin
      .from('product_listings')
      .insert(toInsert)
      .select('listing_id')

    if (!error && inserted) {
      for (const row of inserted as Array<{ listing_id: string }>) {
        results.push({ listing_id: row.listing_id, status: 'created' })
      }
      return { created: inserted.length, skipped, errors: 0, results }
    }

    // 3b. Fallback per-row pra erro detalhado por linha
    let created = 0
    let errors  = 0
    for (const row of toInsert) {
      const { error: e } = await supabaseAdmin.from('product_listings').insert(row)
      if (e) {
        errors++
        results.push({ listing_id: String(row.listing_id), status: 'error', message: e.message })
      } else {
        created++
        results.push({ listing_id: String(row.listing_id), status: 'created' })
      }
    }
    return { created, skipped, errors, results }
  }

  async createStockMovement(dto: CreateStockMovementDto, userId?: string | null) {
    try {
      // Resolve stock record (use shared stock if no explicit stockId)
      let stockId    = dto.product_stock_id ?? null
      let currentQty = 0
      if (!stockId) {
        const { data: stock } = await supabaseAdmin
          .from('product_stock')
          .select('id, quantity')
          .eq('product_id', dto.product_id)
          .is('platform', null)
          .maybeSingle()
        stockId    = stock?.id       ?? null
        currentQty = stock?.quantity ?? 0
      } else {
        const { data: stock } = await supabaseAdmin
          .from('product_stock')
          .select('quantity')
          .eq('id', stockId)
          .maybeSingle()
        currentQty = stock?.quantity ?? 0
      }

      // Compute final balance based on movement type
      const balanceAfter = dto.type === 'adjustment'
        ? dto.quantity
        : dto.type === 'in' || dto.type === 'return'
          ? currentQty + dto.quantity
          : Math.max(0, currentQty - dto.quantity)

      // Insert movement record — column names match the live schema:
      //   stock_id (not product_stock_id), movement_type (not type),
      //   notes (not reason), balance_after (NOT NULL), created_by
      const { error: mvError } = await supabaseAdmin
        .from('stock_movements')
        .insert({
          product_id:    dto.product_id,
          stock_id:      stockId,
          movement_type: dto.type,
          quantity:      dto.quantity,
          notes:         dto.reason ?? null,
          balance_after: balanceAfter,
          created_by:    userId ?? null,
        })
      if (mvError) {
        console.error('[stock.movement] INSERT err:', mvError.code, mvError.message, mvError.details)
        throw new HttpException(mvError.message, 400)
      }

      // Update stock quantity + sync to ML
      if (stockId) {
        await supabaseAdmin
          .from('product_stock')
          .update({ quantity: balanceAfter, updated_at: new Date().toISOString() })
          .eq('id', stockId)

        // Use new path so stock_sync_logs gets populated
        this.stock.recalcAndPropagate(dto.product_id, 'movement')
          .catch((e: Error) => console.error('[stock-sync] movement sync falhou:', e.message))
      }

      return { ok: true, type: dto.type, quantity: dto.quantity, balance_after: balanceAfter }
    } catch (e: unknown) {
      if (e instanceof HttpException) throw e
      const err = e as Error
      console.error('[stock.movement] ERRO:', err?.message, err?.stack)
      throw new HttpException(err?.message ?? 'Erro ao criar movimento de estoque', 400)
    }
  }

  async updateStock(stockId: string, dto: UpdateStockDto) {
    // Fetch current values to calculate platform_qty
    const { data: current } = await supabaseAdmin
      .from('product_stock')
      .select('product_id, quantity, virtual_quantity')
      .eq('id', stockId)
      .maybeSingle()

    const { data, error } = await supabaseAdmin
      .from('product_stock')
      .update({ ...dto, updated_at: new Date().toISOString() })
      .eq('id', stockId)
      .select()
      .single()
    if (error) throw new Error(error.message)

    if (current && (dto.quantity !== undefined || dto.virtual_quantity !== undefined)) {
      this.stock.recalcAndPropagate(current.product_id, 'manual_update')
        .catch((e: Error) => console.error('[stock-sync] updateStock sync falhou:', e.message))
    }

    return data
  }

  async getBySku(orgId: string, sku: string) {
    const { data } = await supabaseAdmin
      .from('products')
      .select('id, name, sku, cost_price, tax_percentage, tax_on_freight')
      .eq('organization_id', orgId)
      .eq('sku', sku)
      .maybeSingle()
    return data ?? null
  }
}
