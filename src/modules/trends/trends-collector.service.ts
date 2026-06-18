import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import { CollectResult } from './trends.types'

const ML_API = 'https://api.mercadolibre.com'
const SITE    = 'MLB'

/** Categorias ML raiz escaneadas por padrão (mercado amplo + foco casa/decoração
 *  do Vazzo). Override por org via trends_settings.categories. */
const DEFAULT_CATEGORIES = [
  'MLB1574',   // Casa, Móveis e Decoração
  'MLB5726',   // Eletrodomésticos
  'MLB1000',   // Eletrônicos, Áudio e Vídeo
  'MLB1051',   // Celulares e Telefones
  'MLB1648',   // Informática
  'MLB1276',   // Esportes e Fitness
  'MLB1246',   // Beleza e Cuidado Pessoal
  'MLB1132',   // Brinquedos e Hobbies
]

/** Quantos best-sellers resolver (via /products) por categoria. */
const TOP_N = 8

interface CatalogProduct {
  id?:         string
  name?:       string
  status?:     string
  domain_id?:  string
  permalink?:  string
  pictures?:   { url?: string }[]
  buy_box_winner?: { price?: number } | null
}

/** F-Trends Fase 1 — coleta os sinais do Mercado Livre e persiste em
 *  trends_signals (série) + trends_products (entidade resolvida).
 *
 *  Fontes (todas validadas live, exigem token ML):
 *    • /trends/MLB[/{cat}]            → keywords mais buscadas (demanda)
 *    • /highlights/MLB/category/{cat} → best sellers reais (vendas)
 *    • /products/{id}                 → nome/preço/foto do produto campeão
 *    • /items/{id}/visits/time_window → visitas no tempo (interesse) */
@Injectable()
export class TrendsCollectorService {
  private readonly logger = new Logger(TrendsCollectorService.name)

  constructor(private readonly mercadolivre: MercadolivreService) {}

  /** Navega a árvore de categorias do ML: sem parent = raízes; com parent =
   *  subcategorias. Alimenta o seletor de categorias da tela. */
  async listCategories(orgId: string, parentId?: string | null): Promise<{ id: string; name: string }[]> {
    let token: string
    try {
      token = (await this.mercadolivre.getTokenForOrg(orgId)).token
    } catch {
      return []
    }
    try {
      if (!parentId) {
        const res = await axios.get(`${ML_API}/sites/${SITE}/categories`, {
          headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
        })
        return (res.data ?? []).map((c: { id: string; name: string }) => ({ id: c.id, name: c.name }))
      }
      const res = await axios.get(`${ML_API}/categories/${parentId}`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
      })
      return (res.data?.children_categories ?? []).map((c: { id: string; name: string }) => ({ id: c.id, name: c.name }))
    } catch (e) {
      this.logger.warn(`[trends.categories] falha parent=${parentId ?? 'root'}: ${this.errMsg(e)}`)
      return []
    }
  }

  /** Busca produtos de catálogo por palavra-chave (a busca de ITENS foi
   *  deprecada; a de PRODUTOS de catálogo `/products/search` funciona).
   *  Resolve cada produto (nome/preço/foto/visitas) igual aos best sellers. */
  async collectByKeyword(orgId: string, keyword: string): Promise<{ resolved: number; errors: string[] }> {
    const result = { resolved: 0, errors: [] as string[] }
    let token: string
    try { token = (await this.mercadolivre.getTokenForOrg(orgId)).token }
    catch { result.errors.push('Conta Mercado Livre não conectada.'); return result }

    let ids: string[] = []
    try {
      const res = await axios.get(`${ML_API}/products/search`, {
        params: { status: 'active', site_id: SITE, q: keyword },
        headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
      })
      ids = ((res.data?.results ?? []) as { id: string }[]).map(r => r.id).filter(Boolean).slice(0, TOP_N)
    } catch (e) {
      result.errors.push(`search "${keyword}": ${this.errMsg(e)}`)
      return result
    }

    for (const id of ids) {
      const prod = await this.resolveProduct(id, token)
      if (!prod) continue
      const metrics = await this.resolveItemMetrics(id, token)
      const priceCents = prod.buy_box_winner?.price != null ? Math.round(prod.buy_box_winner.price * 100) : metrics.priceCents
      await this.upsertProduct(orgId, null, `🔎 ${keyword}`, id, priceCents, prod, metrics.visitsPerDay)
      if (priceCents != null) {
        await supabaseAdmin.from('trends_signals').insert({
          organization_id: orgId, platform: 'mercado_livre', signal_type: 'price',
          external_id: id, metric_value: priceCents,
          payload: metrics.origPriceCents != null ? { orig: metrics.origPriceCents } : {},
        })
      }
      result.resolved++
    }
    this.logger.log(`[trends.search] org=${orgId} "${keyword}" → ${result.resolved} produtos`)
    return result
  }

  /** Contas ML integradas da org (pro seletor de "copiar para minha conta"). */
  async listMlAccounts(orgId: string): Promise<{ seller_id: number; nickname: string | null }[]> {
    const { data } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id, nickname')
      .eq('organization_id', orgId)
    return ((data ?? []) as { seller_id: number; nickname: string | null }[])
  }

  /** Cria um anúncio de CATÁLOGO na conta `sellerId`, vinculado ao mesmo
   *  produto de catálogo (title/fotos/ficha vêm do catálogo automaticamente).
   *  Publicação REAL. Devolve item_id + permalink ou erro legível. */
  async cloneToCatalog(orgId: string, externalId: string, sellerId: number, priceCents: number, stock: number): Promise<{
    seller_id: number; ok: boolean; item_id?: string; permalink?: string; error?: string
  }> {
    let token: string
    try {
      token = (await this.mercadolivre.getTokenForOrg(orgId, sellerId)).token
    } catch {
      return { seller_id: sellerId, ok: false, error: 'Conta ML não conectada ou token inválido.' }
    }
    // ML exige category_id no POST de catálogo — pega do item vencedor.
    let categoryId: string | null = null
    try {
      const it = await axios.get(`${ML_API}/products/${externalId}/items`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
      })
      categoryId = (it.data?.results ?? [])[0]?.category_id ?? null
    } catch { /* segue; ML reclama se faltar */ }

    const body = {
      catalog_product_id: externalId,
      catalog_listing:    true,
      ...(categoryId ? { category_id: categoryId } : {}),
      price:              Math.round(priceCents) / 100,
      currency_id:        'BRL',
      available_quantity: Math.max(1, Math.floor(stock)),
      condition:          'new',
      listing_type_id:    'gold_special',
      sale_terms: [
        { id: 'WARRANTY_TYPE', value_name: 'Garantia do vendedor' },
        { id: 'WARRANTY_TIME', value_name: '90 dias' },
      ],
    }
    try {
      const res = await axios.post(`${ML_API}/items`, body, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000,
      })
      return { seller_id: sellerId, ok: true, item_id: res.data?.id, permalink: res.data?.permalink }
    } catch (e) {
      // ML devolve mensagem útil (ex: produto não elegível, falta frete, etc.)
      const msg = axios.isAxiosError(e)
        ? (e.response?.data?.message || JSON.stringify(e.response?.data?.cause || e.response?.data) || e.message)
        : (e instanceof Error ? e.message : String(e))
      return { seller_id: sellerId, ok: false, error: String(msg).slice(0, 300) }
    }
  }

  async collect(orgId: string, categories?: string[]): Promise<CollectResult> {
    const result: CollectResult = {
      searchTrends: 0, bestSellers: 0, resolved: 0, categories: 0, errors: [],
    }

    let token: string
    try {
      token = (await this.mercadolivre.getTokenForOrg(orgId)).token
    } catch {
      result.errors.push('Conta Mercado Livre não conectada — conecte em Configurações > Integrações.')
      return result
    }

    const cats = (categories?.length ? categories : DEFAULT_CATEGORIES)
    const catNames = await this.resolveCategoryNames(cats, token)

    // 1. Tendências de busca GLOBAIS (sem categoria)
    await this.collectSearchTrends(orgId, token, null, null, result)

    // 2. Por categoria: busca + best sellers
    for (const catId of cats) {
      result.categories++
      const catName = catNames[catId] ?? null
      await this.collectSearchTrends(orgId, token, catId, catName, result)
      await this.collectBestSellers(orgId, token, catId, catName, result)
    }

    this.logger.log(
      `[trends.collect] org=${orgId} cats=${result.categories} ` +
      `searchTrends=${result.searchTrends} bestSellers=${result.bestSellers} resolved=${result.resolved}`,
    )
    return result
  }

  // ── Search trends (keywords) ───────────────────────────────────────────

  private async collectSearchTrends(
    orgId: string, token: string, catId: string | null, catName: string | null, result: CollectResult,
  ): Promise<void> {
    const url = catId ? `${ML_API}/trends/${SITE}/${catId}` : `${ML_API}/trends/${SITE}`
    let data: { keyword?: string; url?: string }[]
    try {
      const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 })
      data = Array.isArray(res.data) ? res.data : []
    } catch (e) {
      result.errors.push(`trends ${catId ?? 'global'}: ${this.errMsg(e)}`)
      return
    }

    const rows = data.slice(0, 30).map((t, i) => ({
      organization_id: orgId,
      platform:        'mercado_livre',
      signal_type:     'search_trend',
      category_id:     catId,
      category_name:   catName,
      term:            t.keyword ?? null,
      position:        i + 1,
      payload:         { url: t.url ?? null },
    }))
    if (!rows.length) return

    const { error } = await supabaseAdmin.from('trends_signals').insert(rows)
    if (error) { result.errors.push(`insert search_trend: ${error.message}`); return }
    result.searchTrends += rows.length
  }

  // ── Best sellers (produtos campeões) ────────────────────────────────────

  private async collectBestSellers(
    orgId: string, token: string, catId: string, catName: string | null, result: CollectResult,
  ): Promise<void> {
    let content: { id: string; position: number; type: string }[]
    try {
      const res = await axios.get(`${ML_API}/highlights/${SITE}/category/${catId}`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
      })
      content = Array.isArray(res.data?.content) ? res.data.content : []
    } catch (e) {
      result.errors.push(`highlights ${catId}: ${this.errMsg(e)}`)
      return
    }
    if (!content.length) return

    // sinal de best seller (todos, leve)
    const signals = content.slice(0, 30).map(c => ({
      organization_id: orgId,
      platform:        'mercado_livre',
      signal_type:     'best_seller',
      category_id:     catId,
      category_name:   catName,
      external_id:     c.id,
      position:        c.position,
      payload:         { type: c.type },
    }))
    const { error: sigErr } = await supabaseAdmin.from('trends_signals').insert(signals)
    if (sigErr) result.errors.push(`insert best_seller: ${sigErr.message}`)
    result.bestSellers += signals.length

    // resolver top N (nome/preço/foto) → upsert trends_products
    const top = content.filter(c => c.type === 'PRODUCT').slice(0, TOP_N)
    for (const c of top) {
      const prod = await this.resolveProduct(c.id, token)
      if (!prod) continue
      // item vencedor → preço (buy_box vem null no catálogo) + visitas/dia (7d)
      const metrics = await this.resolveItemMetrics(c.id, token)
      const priceCents = prod.buy_box_winner?.price != null
        ? Math.round(prod.buy_box_winner.price * 100)
        : metrics.priceCents
      await this.upsertProduct(orgId, catId, catName, c.id, priceCents, prod, metrics.visitsPerDay)
      // série de preço (histórico p/ a tela de Análise) — só quando há preço.
      // payload.orig = preço cheio quando há desconto (pra calcular % por dia).
      if (priceCents != null) {
        await supabaseAdmin.from('trends_signals').insert({
          organization_id: orgId, platform: 'mercado_livre', signal_type: 'price',
          category_id: catId, external_id: c.id, metric_value: priceCents,
          payload: metrics.origPriceCents != null ? { orig: metrics.origPriceCents } : {},
        })
      }
      result.resolved++
    }
  }

  /** Resolve o item vencedor do produto de catálogo e devolve preço (menor) +
   *  visitas/dia (média dos últimos 7d). 1-2 chamadas ML por produto. */
  private async resolveItemMetrics(productId: string, token: string): Promise<{ priceCents: number | null; origPriceCents: number | null; visitsPerDay: number | null }> {
    let itemId: string | null = null
    let priceCents: number | null = null
    let origPriceCents: number | null = null
    try {
      const res = await axios.get(`${ML_API}/products/${productId}/items`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
      })
      const results = (res.data?.results ?? []) as { item_id?: string; price?: number; original_price?: number }[]
      const withPrice = results.filter(r => typeof r.price === 'number' && r.price! > 0)
      if (withPrice.length) {
        const cheapest = withPrice.reduce((a, b) => (a.price! <= b.price! ? a : b))
        itemId = cheapest.item_id ?? null
        priceCents = Math.round(cheapest.price! * 100)
        // preço cheio (de) quando há desconto; só vale se > preço final
        if (typeof cheapest.original_price === 'number' && cheapest.original_price > cheapest.price!) {
          origPriceCents = Math.round(cheapest.original_price * 100)
        }
      } else if (results[0]?.item_id) {
        itemId = results[0].item_id
      }
    } catch { return { priceCents, origPriceCents, visitsPerDay: null } }

    if (!itemId) return { priceCents, origPriceCents, visitsPerDay: null }
    try {
      const v = await axios.get(`${ML_API}/items/${itemId}/visits/time_window?last=7&unit=day`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
      })
      const total = v.data?.total_visits ?? 0
      const dias = (v.data?.results ?? []).length || 7
      return { priceCents, origPriceCents, visitsPerDay: Math.round(total / dias) }
    } catch {
      return { priceCents, origPriceCents, visitsPerDay: null }
    }
  }

  /** Análise ao vivo de UM produto: resolve o item vencedor → visitas (até 90d,
   *  histórico real do ML) + preço atual. Vendas/conversão NÃO existem pra item
   *  de terceiro (ML bloqueia com 403/privacidade). */
  async getLiveAnalytics(orgId: string, externalId: string, days: number): Promise<{
    visits: { date: string; total: number }[]
    visitsTotal: number
    currentPriceCents: number | null
    currentOrigPriceCents: number | null
    available: boolean
  }> {
    const empty = { visits: [], visitsTotal: 0, currentPriceCents: null, currentOrigPriceCents: null, available: false }
    let token: string
    try { token = (await this.mercadolivre.getTokenForOrg(orgId)).token } catch { return empty }

    // item vencedor + preço atual (final + cheio)
    let itemId: string | null = null
    let currentPriceCents: number | null = null
    let currentOrigPriceCents: number | null = null
    try {
      const res = await axios.get(`${ML_API}/products/${externalId}/items`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
      })
      const results = (res.data?.results ?? []) as { item_id?: string; price?: number; original_price?: number }[]
      const withPrice = results.filter(r => typeof r.price === 'number' && r.price! > 0)
      if (withPrice.length) {
        const cheapest = withPrice.reduce((a, b) => (a.price! <= b.price! ? a : b))
        itemId = cheapest.item_id ?? null
        currentPriceCents = Math.round(cheapest.price! * 100)
        if (typeof cheapest.original_price === 'number' && cheapest.original_price > cheapest.price!) {
          currentOrigPriceCents = Math.round(cheapest.original_price * 100)
        }
      } else if (results[0]?.item_id) {
        itemId = results[0].item_id
      }
    } catch { /* segue sem item */ }

    if (!itemId) return { ...empty, currentPriceCents, currentOrigPriceCents }

    const last = Math.min(Math.max(days, 1), 150)
    try {
      const v = await axios.get(`${ML_API}/items/${itemId}/visits/time_window?last=${last}&unit=day`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
      })
      const results = (v.data?.results ?? []) as { date?: string; total?: number }[]
      const visits = results
        .filter(r => r.date)
        .map(r => ({ date: (r.date as string).slice(0, 10), total: r.total ?? 0 }))
        .sort((a, b) => a.date.localeCompare(b.date))
      return { visits, visitsTotal: v.data?.total_visits ?? 0, currentPriceCents, currentOrigPriceCents, available: true }
    } catch {
      return { ...empty, currentPriceCents, currentOrigPriceCents }
    }
  }

  /** Refresh diário de UM produto observado: atualiza preço + visitas/dia e
   *  grava o ponto de preço na série (histórico acumula na página do produto). */
  async refreshProductMetrics(orgId: string, externalId: string): Promise<void> {
    let token: string
    try { token = (await this.mercadolivre.getTokenForOrg(orgId)).token } catch { return }
    const m = await this.resolveItemMetrics(externalId, token)
    const patch: Record<string, unknown> = { last_seen_at: new Date().toISOString() }
    if (m.priceCents != null)   patch.price_ref_cents = m.priceCents
    if (m.visitsPerDay != null) patch.visits_per_day = m.visitsPerDay
    await supabaseAdmin.from('trends_products').update(patch)
      .eq('organization_id', orgId).eq('external_id', externalId)
    if (m.priceCents != null) {
      await supabaseAdmin.from('trends_signals').insert({
        organization_id: orgId, platform: 'mercado_livre', signal_type: 'price',
        external_id: externalId, metric_value: m.priceCents,
        payload: m.origPriceCents != null ? { orig: m.origPriceCents, source: 'watchlist_refresh' } : { source: 'watchlist_refresh' },
      })
    }
  }

  private async resolveProduct(productId: string, token: string): Promise<CatalogProduct | null> {
    try {
      const res = await axios.get(`${ML_API}/products/${productId}`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
      })
      return res.data as CatalogProduct
    } catch {
      return null
    }
  }

  private async upsertProduct(
    orgId: string, catId: string | null, catName: string | null,
    externalId: string, priceCents: number | null, prod: CatalogProduct, visitsPerDay: number | null,
  ): Promise<void> {
    const now = new Date().toISOString()

    const row: Record<string, unknown> = {
      organization_id: orgId,
      platform:        'mercado_livre',
      external_id:     externalId,
      kind:            'catalog_product',
      name:            prod.name ?? externalId,
      category_id:     catId,
      category_name:   catName,
      domain_id:       prod.domain_id ?? null,
      price_ref_cents: priceCents,
      status:          prod.status ?? null,
      thumbnail:       prod.pictures?.[0]?.url ?? null,
      url:             prod.permalink ?? null,
      last_seen_at:    now,
    }
    if (visitsPerDay != null) row.visits_per_day = visitsPerDay

    const { error } = await supabaseAdmin.from('trends_products').upsert(row,
      { onConflict: 'organization_id,platform,external_id', ignoreDuplicates: false })

    if (error) this.logger.warn(`[trends.collect] upsert product ${externalId} falhou: ${error.message}`)
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  /** Nomes das categorias (1 fetch /categories/{id} por categoria). */
  private async resolveCategoryNames(cats: string[], token: string): Promise<Record<string, string>> {
    const map: Record<string, string> = {}
    await Promise.all(cats.map(async catId => {
      try {
        const res = await axios.get(`${ML_API}/categories/${catId}`, {
          headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
        })
        if (res.data?.name) map[catId] = res.data.name as string
      } catch { /* nome é best-effort */ }
    }))
    return map
  }

  private errMsg(e: unknown): string {
    if (axios.isAxiosError(e)) return `${e.response?.status ?? ''} ${e.code ?? e.message}`.trim()
    return e instanceof Error ? e.message : String(e)
  }
}
