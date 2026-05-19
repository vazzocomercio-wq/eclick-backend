import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/**
 * Operação de Cadastro — visão de cobertura de anúncios (2026-05-19).
 *
 * Complementa o eixo "cadastro completo" (ProductsCompletenessService) com o
 * eixo "tem anúncio?". Monta a matriz produto × destino, onde destino é
 * um par (canal × conta):
 *   - Mercado Livre: 1 destino por conta conectada (ml_connections)
 *   - Outros marketplaces: 1 destino por conexão ativa (marketplace_connections)
 *   - Loja própria: NÃO entra na matriz de destinos (é curadoria, não
 *     "deveria estar em todos") — vai como flag informativa `na_loja`.
 *
 * Um produto cobre um destino quando tem product_listings ativo com
 * platform+account_id batendo. É destino-aware: marketplace novo conectado
 * entra sozinho na matriz, sem mudar código.
 */

export interface CoverageDestino {
  key:       string         // 'mercadolivre:2290161131'
  channel:   string         // 'mercadolivre' | 'shopee' | 'amazon' | 'magalu'
  accountId: string | null
  label:     string
}

export interface CoverageProduct {
  id:                string
  sku:               string | null
  name:              string
  stock:             number | null
  cadastro_completo: boolean
  na_loja:           boolean
  covered:           string[]   // keys de destino cobertos
  missing:           string[]   // keys de destino faltando
  status:            'sem_anuncio' | 'parcial' | 'completo'
}

export interface CoverageResult {
  destinos: CoverageDestino[]
  summary: {
    total:                          number
    sem_anuncio:                    number
    parcial:                        number
    completo:                       number
    cadastro_completo_sem_anuncio:  number
  }
  sample: CoverageProduct[]
}

@Injectable()
export class ProductsListingCoverageService {
  private readonly log = new Logger(ProductsListingCoverageService.name)

  /** Resolve os destinos de marketplace que a org opera AGORA. */
  async resolveDestinos(orgId: string): Promise<CoverageDestino[]> {
    const destinos: CoverageDestino[] = []

    // Mercado Livre — fonte canônica ml_connections (1 destino por conta)
    const { data: mlConns } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id, nickname')
      .eq('organization_id', orgId)
    for (const c of mlConns ?? []) {
      const acc = String(c.seller_id)
      destinos.push({
        key:       `mercadolivre:${acc}`,
        channel:   'mercadolivre',
        accountId: acc,
        label:     (c.nickname as string | null) || `ML ${acc}`,
      })
    }

    // Outros marketplaces conectados (Shopee / Amazon / Magalu / ...)
    const { data: mpConns } = await supabaseAdmin
      .from('marketplace_connections')
      .select('platform, seller_id, shop_id, external_id, nickname')
      .eq('organization_id', orgId)
      .eq('status', 'connected')
      .neq('platform', 'mercadolivre')
    for (const c of mpConns ?? []) {
      const acc = String(c.seller_id ?? c.shop_id ?? c.external_id ?? '')
      destinos.push({
        key:       `${c.platform}:${acc}`,
        channel:   c.platform as string,
        accountId: acc || null,
        label:     (c.nickname as string | null) || `${c.platform} ${acc}`.trim(),
      })
    }

    return destinos
  }

  /** Matriz de cobertura produto × destino + resumo. */
  async getCoverage(orgId: string, opts: {
    sample_size?:   number
    stock_min?:     number
    stock_max?:     number
    search?:        string
    sort?:          'stock_desc' | 'stock_asc' | 'name'
    coverage?:      'sem' | 'parcial' | 'all'
    only_complete?: boolean
  } = {}): Promise<CoverageResult> {
    const sampleSize = Math.min(Math.max(opts.sample_size ?? 200, 10), 500)

    const destinos    = await this.resolveDestinos(orgId)
    const destinoKeys = destinos.map(d => d.key)
    const channelKeys = (ch: string) => destinos.filter(d => d.channel === ch).map(d => d.key)

    // 1. Todos os produtos da org (paginado — pode passar de 1000)
    type ProdRow = {
      id: string; sku: string | null; name: string | null
      stock: number | null; catalog_status: string | null; storefront_visible: boolean | null
    }
    const products: ProdRow[] = []
    const PAGE = 1000
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabaseAdmin
        .from('products')
        .select('id, sku, name, stock, catalog_status, storefront_visible')
        .eq('organization_id', orgId)
        .range(from, from + PAGE - 1)
      if (error) throw new Error(error.message)
      const batch = (data ?? []) as ProdRow[]
      products.push(...batch)
      if (batch.length < PAGE) break
    }

    // 2. Listings ativos da org (join via products pra escopo multi-tenant)
    type ListRow = { product_id: string; platform: string; account_id: string | null }
    const listings: ListRow[] = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabaseAdmin
        .from('product_listings')
        .select('product_id, platform, account_id, products!inner(organization_id)')
        .eq('is_active', true)
        .eq('products.organization_id', orgId)
        .range(from, from + PAGE - 1)
      if (error) throw new Error(error.message)
      const batch = (data ?? []) as unknown as ListRow[]
      listings.push(...batch.map(l => ({ product_id: l.product_id, platform: l.platform, account_id: l.account_id })))
      if (batch.length < PAGE) break
    }

    // produto → set de chaves de destino cobertas
    const coveredByProduct = new Map<string, Set<string>>()
    const mark = (pid: string, key: string) => {
      let s = coveredByProduct.get(pid)
      if (!s) { s = new Set(); coveredByProduct.set(pid, s) }
      s.add(key)
    }
    for (const l of listings) {
      if (!l.product_id || !l.platform) continue
      if (l.account_id) {
        mark(l.product_id, `${l.platform}:${l.account_id}`)
      } else {
        // conta não identificada → conta como cobrindo todos os destinos do canal
        for (const k of channelKeys(l.platform)) mark(l.product_id, k)
      }
    }

    // 3. Classifica cada produto contra os destinos de marketplace
    const all: CoverageProduct[] = products.map(p => {
      const covSet  = coveredByProduct.get(p.id) ?? new Set<string>()
      const covered = destinoKeys.filter(k => covSet.has(k))
      const missing = destinoKeys.filter(k => !covSet.has(k))
      const status: CoverageProduct['status'] =
        destinoKeys.length === 0 ? 'completo'      // org sem marketplace conectado
        : covered.length === 0   ? 'sem_anuncio'
        : missing.length === 0   ? 'completo'
        :                          'parcial'
      return {
        id:    p.id,
        sku:   p.sku,
        name:  p.name ?? '',
        stock: p.stock ?? null,
        cadastro_completo: p.catalog_status === 'ready',
        na_loja:           p.storefront_visible === true,
        covered, missing, status,
      }
    })

    // 4. Resumo (sobre TODOS os produtos)
    const summary = {
      total:       all.length,
      sem_anuncio: all.filter(p => p.status === 'sem_anuncio').length,
      parcial:     all.filter(p => p.status === 'parcial').length,
      completo:    all.filter(p => p.status === 'completo').length,
      cadastro_completo_sem_anuncio:
        all.filter(p => p.status === 'sem_anuncio' && p.cadastro_completo).length,
    }

    // 5. Sample — só o que FALTA anunciar (sem_anuncio/parcial), filtrado e ordenado
    let filtered = all.filter(p => p.status !== 'completo')
    if (opts.coverage === 'sem')     filtered = filtered.filter(p => p.status === 'sem_anuncio')
    if (opts.coverage === 'parcial') filtered = filtered.filter(p => p.status === 'parcial')
    if (opts.only_complete)          filtered = filtered.filter(p => p.cadastro_completo)
    if (opts.stock_min != null)      filtered = filtered.filter(p => (p.stock ?? 0) >= opts.stock_min!)
    if (opts.stock_max != null)      filtered = filtered.filter(p => (p.stock ?? 0) <= opts.stock_max!)
    if (opts.search?.trim()) {
      const s = opts.search.trim().toLowerCase()
      filtered = filtered.filter(p =>
        p.name.toLowerCase().includes(s) || (p.sku ?? '').toLowerCase().includes(s))
    }
    if (opts.sort === 'stock_asc')  filtered.sort((a, b) => (a.stock ?? 0) - (b.stock ?? 0))
    else if (opts.sort === 'name')  filtered.sort((a, b) => a.name.localeCompare(b.name))
    else                            filtered.sort((a, b) => (b.stock ?? 0) - (a.stock ?? 0))

    return { destinos, summary, sample: filtered.slice(0, sampleSize) }
  }
}
