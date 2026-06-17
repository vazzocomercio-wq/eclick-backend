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
      // buy_box_winner costuma vir null no catálogo → preço real vem dos itens
      let priceCents = prod.buy_box_winner?.price != null
        ? Math.round(prod.buy_box_winner.price * 100)
        : null
      if (priceCents == null) priceCents = await this.fetchPriceCents(c.id, token)
      await this.upsertProduct(orgId, catId, catName, c.id, priceCents, prod)
      result.resolved++
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

  /** Preço de referência = menor preço entre os itens que vendem o produto de
   *  catálogo (o que o comprador vê). buy_box_winner do /products vem null. */
  private async fetchPriceCents(productId: string, token: string): Promise<number | null> {
    try {
      const res = await axios.get(`${ML_API}/products/${productId}/items`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
      })
      const prices = (res.data?.results ?? [])
        .map((r: { price?: number }) => r.price)
        .filter((p: unknown): p is number => typeof p === 'number' && p > 0)
      if (!prices.length) return null
      return Math.round(Math.min(...prices) * 100)
    } catch {
      return null
    }
  }

  private async upsertProduct(
    orgId: string, catId: string, catName: string | null,
    externalId: string, priceCents: number | null, prod: CatalogProduct,
  ): Promise<void> {
    const now = new Date().toISOString()

    const { error } = await supabaseAdmin.from('trends_products').upsert({
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
    }, { onConflict: 'organization_id,platform,external_id', ignoreDuplicates: false })

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
