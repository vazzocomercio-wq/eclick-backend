import { Injectable, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import { MlListingPricesService } from '../mercadolivre/ml-listing-prices.service'
import { MlShippingCostService } from '../mercadolivre/ml-shipping-cost.service'

/**
 * e-Click Radar IA — serviço read-only que alimenta as 2 telas do módulo.
 * Lê as tabelas radar_* (populadas pelo coletor no eclick-workers).
 * Agregados da watchlist calculados em memória (queries bulk, sem N+1).
 */
@Injectable()
export class RadarService {
  constructor(
    private readonly mercadolivre: MercadolivreService,
    private readonly listingPrices: MlListingPricesService,
    private readonly shippingCost: MlShippingCostService,
  ) {}
  /** Tela 1 — produtos da watchlist + agregados por produto. */
  async listProducts(orgId: string, status?: string) {
    const sb = supabaseAdmin

    let pq = sb
      .from('radar_catalog_products')
      .select('id,catalog_product_id,title,category_id,status,origem,product_id,updated_at')
      .eq('organization_id', orgId)
    if (status === 'ativo' || status === 'pausado') pq = pq.eq('status', status)
    const { data: products, error: pe } = await pq
    if (pe) throw new Error(`radar_catalog_products: ${pe.message}`)

    const { data: offers, error: oe } = await sb
      .from('radar_offers')
      .select('catalog_product_ref,price,is_own,item_id,price_to_win,catalog_status,thumbnail')
      .eq('organization_id', orgId)
      .eq('status', 'ativo')
    if (oe) throw new Error(`radar_offers: ${oe.message}`)

    const { data: events, error: ee } = await sb
      .from('radar_events')
      .select('catalog_product_ref')
      .eq('organization_id', orgId)
      .eq('status', 'novo')
    if (ee) throw new Error(`radar_events: ${ee.message}`)

    const since = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const { data: snaps, error: se } = await sb
      .from('radar_offer_snapshots')
      .select('catalog_product_ref,price,collected_at')
      .eq('organization_id', orgId)
      .gte('collected_at', since)
    if (se) throw new Error(`radar_offer_snapshots: ${se.message}`)

    const calibration = await this.loadCalibration(orgId)
    const visits30d = await this.visits30dByItem(orgId)

    // SKU + foto vêm da tabela products (radar_catalog_products.product_id).
    const productIds = [...new Set(
      (products ?? []).map((p) => p.product_id).filter((x): x is string => typeof x === 'string'),
    )]
    const metaByProduct = new Map<string, { sku: string | null; photo: string | null }>()
    if (productIds.length > 0) {
      const { data: prods } = await sb.from('products').select('id,sku,photo_urls').in('id', productIds)
      for (const pr of prods ?? []) {
        const photos = pr.photo_urls as string[] | null
        metaByProduct.set(pr.id as string, {
          sku: (pr.sku as string | null) ?? null,
          photo: Array.isArray(photos) && photos.length > 0 ? photos[0] : null,
        })
      }
    }

    const offersByCp = groupBy(offers ?? [], (o) => o.catalog_product_ref as string)
    const eventsByCp = new Map<string, number>()
    for (const e of events ?? []) {
      const k = e.catalog_product_ref as string
      eventsByCp.set(k, (eventsByCp.get(k) ?? 0) + 1)
    }
    const deltaByCp = computeMinPriceDeltas(snaps ?? [])

    return (products ?? []).map((p) => {
      const offs = offersByCp.get(p.id as string) ?? []
      const prices = numbers(offs.map((o) => o.price))
      const minPrice = prices.length ? Math.min(...prices) : null
      const vazzoPrices = numbers(offs.filter((o) => o.is_own === true).map((o) => o.price))
      const vazzoPrice = vazzoPrices.length ? Math.min(...vazzoPrices) : null
      const competitorPrices = numbers(offs.filter((o) => o.is_own !== true).map((o) => o.price))
      const runnerUpPrice = competitorPrices.length ? Math.min(...competitorPrices) : null
      const ownOffer = offs.find((o) => o.is_own === true) ?? null
      const rate = effectiveRate(calibration, (p.category_id as string | null) ?? null).rate
      const marketDemand = rate == null
        ? null
        : Math.round(offs.reduce((acc, o) => acc + (visits30d.get(o.item_id as string) ?? 0) * rate, 0))
      const meta = typeof p.product_id === 'string' ? metaByProduct.get(p.product_id) : undefined
      return {
        ...p,
        sku: meta?.sku ?? null,
        thumbnail: meta?.photo ?? (ownOffer?.thumbnail as string | null) ?? null,
        price_to_win: (ownOffer?.price_to_win as number | null) ?? null,
        catalog_status: (ownOffer?.catalog_status as string | null) ?? null,
        vazzo_item_id: (ownOffer?.item_id as string | null) ?? null,
        competitors: offs.filter((o) => o.is_own !== true).length,
        total_offers: offs.length,
        min_price: minPrice,
        vazzo_price: vazzoPrice,
        runner_up_price: runnerUpPrice,
        vazzo_has_lead: vazzoPrice != null && minPrice != null && vazzoPrice === minPrice,
        price_delta_pct: deltaByCp.get(p.id as string) ?? null,
        new_events: eventsByCp.get(p.id as string) ?? 0,
        market_demand: marketDemand,
      }
    })
  }

  /** Tela 1 — KPI strip. */
  async getSummary(orgId: string) {
    const sb = supabaseAdmin
    const products = await this.listProducts(orgId)
    const sellerSet = new Set<string>()
    const { data: sellers } = await sb
      .from('radar_sellers')
      .select('id')
      .eq('organization_id', orgId)
    for (const s of sellers ?? []) sellerSet.add(s.id as string)

    const calibration = await this.loadCalibration(orgId)
    return {
      products_monitored: products.filter((p) => p.status === 'ativo').length,
      products_total: products.length,
      competitors: sellerSet.size,
      new_events: products.reduce((acc, p) => acc + p.new_events, 0),
      products_losing_lead: products.filter((p) => !p.vazzo_has_lead && p.min_price != null).length,
      market_demand_total: products.reduce((acc, p) => acc + (p.market_demand ?? 0), 0),
      conversion: {
        rate: calibration.org_rate,
        confidence: calibration.org_confidence,
        own_visits: calibration.org_visits,
        own_units: calibration.org_units,
        calc_date: calibration.calc_date,
      },
    }
  }

  /**
   * Status real do catálogo dos itens próprios (price_to_win). Usado pelas
   * telas de anúncios pra refletir ganhando/perdendo + preço pra ganhar.
   */
  async getCatalogStatus(orgId: string) {
    const { data, error } = await supabaseAdmin
      .from('radar_offers')
      .select('item_id,price,price_to_win,catalog_status,catalog_winner_price,price_to_win_checked_at')
      .eq('organization_id', orgId)
      .eq('is_own', true)
      .not('catalog_status', 'is', null)
    if (error) throw new Error(`radar_offers: ${error.message}`)
    return data ?? []
  }

  /**
   * Teto do catálogo por anúncio próprio: o preço do concorrente mais barato
   * no mesmo produto de catálogo. Usado pela tela de Anúncios ML pra mostrar
   * até onde dá pra subir o preço sem perder a ponta. `itemIds` = MLBs.
   */
  async getCatalogCeiling(
    orgId: string,
    itemIds: string[],
  ): Promise<Array<{ item_id: string; runner_up_price: number | null; runner_up_seller: string | null }>> {
    const ids = [...new Set(itemIds.filter((x) => typeof x === 'string' && x))].slice(0, 100)
    if (ids.length === 0) return []
    const sb = supabaseAdmin

    // Anúncios próprios → resolve o produto de catálogo de cada um.
    const { data: own } = await sb
      .from('radar_offers')
      .select('item_id,catalog_product_ref')
      .eq('organization_id', orgId)
      .eq('is_own', true)
      .in('item_id', ids)
    const ownRows = (own ?? []) as Array<{ item_id: string; catalog_product_ref: string }>
    if (ownRows.length === 0) return []

    const refs = [...new Set(ownRows.map((o) => o.catalog_product_ref))]

    // Concorrente mais barato por catálogo (ordenado asc → 1ª linha = menor).
    const { data: comps } = await sb
      .from('radar_offers')
      .select('catalog_product_ref,price,seller:seller_ref(nickname)')
      .eq('organization_id', orgId)
      .eq('status', 'ativo')
      .not('is_own', 'is', true)
      .not('price', 'is', null)
      .in('catalog_product_ref', refs)
      .order('price', { ascending: true })

    const cheapestByRef = new Map<string, { price: number; seller: string | null }>()
    for (const c of (comps ?? []) as Array<{ catalog_product_ref: string; price: number; seller: unknown }>) {
      if (cheapestByRef.has(c.catalog_product_ref)) continue
      cheapestByRef.set(c.catalog_product_ref, {
        price: c.price,
        seller: (oneOf(c.seller) as { nickname?: string } | null)?.nickname ?? null,
      })
    }

    return ownRows.map((o) => {
      const cheapest = cheapestByRef.get(o.catalog_product_ref)
      return {
        item_id: o.item_id,
        runner_up_price: cheapest?.price ?? null,
        runner_up_seller: cheapest?.seller ?? null,
      }
    })
  }

  /**
   * Contexto de preço de um produto pra o modal "Ajustar preço": preço atual,
   * preço pra ganhar o catálogo (ao vivo), custo, imposto, tarifa ML e frete —
   * pra o modal calcular a margem em qualquer preço.
   */
  async getPriceContext(orgId: string, productId: string) {
    const sb = supabaseAdmin
    const { data: cp } = await sb
      .from('radar_catalog_products')
      .select('id,category_id,product_id')
      .eq('organization_id', orgId)
      .eq('id', productId)
      .maybeSingle()
    if (!cp) throw new NotFoundException('Produto de catálogo não encontrado')

    const { data: offer } = await sb
      .from('radar_offers')
      .select('item_id,price,listing_type,catalog_status,price_to_win,seller:seller_ref(seller_id)')
      .eq('organization_id', orgId)
      .eq('catalog_product_ref', productId)
      .eq('is_own', true)
      .order('price', { ascending: true, nullsFirst: false })
      .limit(1)
      .maybeSingle()

    // Concorrente mais barato — vira o "teto" do catálogo quando o item
    // próprio está ganhando: até quanto dá pra subir sem perder a ponta.
    const { data: rival } = await sb
      .from('radar_offers')
      .select('price,seller:seller_ref(nickname)')
      .eq('organization_id', orgId)
      .eq('catalog_product_ref', productId)
      .eq('status', 'ativo')
      .not('is_own', 'is', true)
      .not('price', 'is', null)
      .order('price', { ascending: true })
      .limit(1)
      .maybeSingle()
    const runnerUpPrice = typeof rival?.price === 'number' ? rival.price : null
    const runnerUpSeller = (oneOf(rival?.seller) as { nickname?: string } | null)?.nickname ?? null

    let cost: number | null = null
    let taxPct: number | null = null
    if (cp.product_id) {
      const { data: p } = await sb
        .from('products')
        .select('cost_price,tax_percentage')
        .eq('id', cp.product_id)
        .maybeSingle()
      if (p) {
        cost = (p.cost_price as number | null) ?? null
        taxPct = (p.tax_percentage as number | null) ?? null
      }
    }

    const base = {
      cost, tax_pct: taxPct, fee_pct: null as number | null,
      fixed_fee: null as number | null, shipping_cost: null as number | null,
      runner_up_price: runnerUpPrice, runner_up_seller: runnerUpSeller,
    }
    if (!offer) {
      return { has_listing: false, item_id: null, current_price: null, price_to_win: null, catalog_status: null, ...base }
    }

    const sellerId = (oneOf(offer.seller) as { seller_id?: number } | null)?.seller_id
    const itemId = offer.item_id as string
    const price = typeof offer.price === 'number' ? offer.price : 0

    let token: string | null = null
    try {
      token = (await this.mercadolivre.getTokenForOrg(orgId, sellerId)).token
    } catch { /* sem token — segue sem tarifa/frete */ }

    let priceToWin = (offer.price_to_win as number | null) ?? null
    let catalogStatus = (offer.catalog_status as string | null) ?? null
    try {
      const ptw = await this.mercadolivre.fetchPriceToWin(orgId, [{ item_id: itemId, seller_id: sellerId }])
      if (ptw[0]) {
        priceToWin = ptw[0].price_to_win ?? priceToWin
        catalogStatus = ptw[0].catalog_status ?? catalogStatus
      }
    } catch { /* mantém o do banco */ }

    const listingType = (offer.listing_type as string | null) ?? 'gold_special'
    if (token && cp.category_id && price > 0) {
      try {
        const fee = await this.listingPrices.getFee(token, {
          categoryId: cp.category_id as string,
          listingTypeId: listingType,
          price,
        })
        if (fee) { base.fee_pct = fee.percentageFee; base.fixed_fee = fee.fixedFee }
      } catch { /* sem tarifa */ }
    }

    if (token) {
      try {
        // Frete via dimensões REAIS do anúncio (atributos SELLER_PACKAGE_*).
        const r = await this.shippingCost.getItemFreeShippingCost(token, itemId)
        base.shipping_cost = r?.sellerCost ?? null
      } catch { /* sem frete */ }
    }

    return {
      has_listing: true,
      item_id: itemId,
      current_price: price,
      price_to_win: priceToWin,
      catalog_status: catalogStatus,
      ...base,
    }
  }

  /** Tela 1 — feed "o que mudou" (eventos da org inteira). */
  async listEvents(orgId: string, limit = 50) {
    const sb = supabaseAdmin
    const { data, error } = await sb
      .from('radar_events')
      .select('*, catalog:catalog_product_ref(id,title,catalog_product_id)')
      .eq('organization_id', orgId)
      .order('detected_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 200))
    if (error) throw new Error(`radar_events: ${error.message}`)
    return (data ?? []).map((e) => ({ ...e, catalog: oneOf(e.catalog) }))
  }

  /** Tela 2 — produto + ranking competitivo + dados de margem. */
  async getProduct(orgId: string, id: string) {
    const sb = supabaseAdmin
    const { data: product, error: pe } = await sb
      .from('radar_catalog_products')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (pe) throw new Error(`radar_catalog_products: ${pe.message}`)
    if (!product) throw new NotFoundException('Produto de catálogo não encontrado')

    const { data: offers, error: oe } = await sb
      .from('radar_offers')
      .select('*, seller:seller_ref(nickname,reputation_level,power_seller_status,is_official_store)')
      .eq('organization_id', orgId)
      .eq('catalog_product_ref', id)
      .eq('status', 'ativo')
      .order('price', { ascending: true, nullsFirst: false })
    if (oe) throw new Error(`radar_offers: ${oe.message}`)

    let internal: Record<string, unknown> | null = null
    if (product.product_id) {
      const { data: ip } = await sb
        .from('products')
        .select('id,name,cost_price,my_price,tax_percentage')
        .eq('id', product.product_id)
        .maybeSingle()
      internal = ip ?? null
    }

    // Motor 2 — demanda estimada por oferta: visitas 30d × conversão calibrada.
    const calibration = await this.loadCalibration(orgId)
    const visits30d = await this.visits30dByItem(orgId, id)
    const { rate, basis } = effectiveRate(calibration, (product.category_id as string | null) ?? null)

    const enrichedOffers = (offers ?? []).map((o) => {
      const v = visits30d.get(o.item_id as string) ?? 0
      const estUnits = rate == null ? null : Math.round(v * rate)
      const price = typeof o.price === 'number' ? o.price : null
      return {
        ...o,
        seller: oneOf(o.seller),
        visits_30d: v,
        est_units_30d: estUnits,
        est_revenue_30d: estUnits != null && price != null ? Math.round(estUnits * price) : null,
      }
    })

    return {
      product,
      offers: enrichedOffers,
      internal,
      calibration: {
        rate,
        basis,
        confidence: calibration.org_confidence,
        own_visits: calibration.org_visits,
        own_units: calibration.org_units,
        calc_date: calibration.calc_date,
      },
    }
  }

  /** Tela 2 — séries: histórico de preço (Vazzo + top 4 concorrentes) + visitas. */
  async getSeries(orgId: string, id: string) {
    const sb = supabaseAdmin

    const { data: offers } = await sb
      .from('radar_offers')
      .select('item_id,price,is_own')
      .eq('organization_id', orgId)
      .eq('catalog_product_ref', id)
      .eq('status', 'ativo')
    const sorted = (offers ?? []).slice().sort(
      (a, b) => (numOr(a.price, 9e15)) - (numOr(b.price, 9e15)),
    )
    const own = sorted.filter((o) => o.is_own === true)
    const competitors = sorted.filter((o) => o.is_own !== true).slice(0, 4)
    const tracked = [...own, ...competitors].slice(0, 6)
    const trackedIds = tracked.map((o) => o.item_id as string)

    const series = tracked.map((o) => ({
      item_id: o.item_id as string,
      is_own: o.is_own === true,
    }))

    let priceHistory: Array<Record<string, unknown>> = []
    if (trackedIds.length > 0) {
      const { data: snaps } = await sb
        .from('radar_offer_snapshots')
        .select('item_id,price,collected_at')
        .eq('organization_id', orgId)
        .eq('catalog_product_ref', id)
        .in('item_id', trackedIds)
        .order('collected_at', { ascending: true })
      const byDate = new Map<string, Record<string, unknown>>()
      for (const s of snaps ?? []) {
        const date = (s.collected_at as string).slice(0, 10)
        let row = byDate.get(date)
        if (!row) {
          row = { date }
          byDate.set(date, row)
        }
        row[s.item_id as string] = s.price
      }
      priceHistory = [...byDate.values()]
    }

    const { data: visitRows } = await sb
      .from('radar_visit_snapshots')
      .select('visit_date,visits')
      .eq('organization_id', orgId)
      .eq('catalog_product_ref', id)
      .order('visit_date', { ascending: true })
    const visitByDate = new Map<string, number>()
    for (const v of visitRows ?? []) {
      const d = v.visit_date as string
      visitByDate.set(d, (visitByDate.get(d) ?? 0) + (Number(v.visits) || 0))
    }
    const visits = [...visitByDate.entries()].map(([date, total]) => ({ date, visits: total }))

    return { series, price_history: priceHistory, visits }
  }

  /** Tela 2 — feed de eventos de um produto. */
  async getProductEvents(orgId: string, id: string) {
    const sb = supabaseAdmin
    const { data, error } = await sb
      .from('radar_events')
      .select('*')
      .eq('organization_id', orgId)
      .eq('catalog_product_ref', id)
      .order('detected_at', { ascending: false })
      .limit(100)
    if (error) throw new Error(`radar_events: ${error.message}`)
    return data ?? []
  }

  /** Motor 2 — calibração de conversão mais recente (por categoria + org-wide). */
  private async loadCalibration(orgId: string): Promise<Calibration> {
    const { data } = await supabaseAdmin
      .from('radar_conversion_calibration')
      .select('calc_date,category_id,conversion_rate,confidence,own_visits,own_units')
      .eq('organization_id', orgId)
      .order('calc_date', { ascending: false })
    const rows = data ?? []
    const latestDate = rows.length ? (rows[0].calc_date as string) : null
    const cal: Calibration = {
      calc_date: latestDate,
      org_rate: null,
      org_confidence: 'low',
      org_visits: 0,
      org_units: 0,
      by_category: new Map(),
    }
    for (const row of rows) {
      if (row.calc_date !== latestDate) continue
      const conf: 'ok' | 'low' = (row.confidence as string) === 'ok' ? 'ok' : 'low'
      if (row.category_id == null) {
        cal.org_rate = (row.conversion_rate as number | null) ?? null
        cal.org_confidence = conf
        cal.org_visits = Number(row.own_visits) || 0
        cal.org_units = Number(row.own_units) || 0
      } else {
        cal.by_category.set(row.category_id as string, {
          rate: (row.conversion_rate as number | null) ?? null,
          confidence: conf,
        })
      }
    }
    return cal
  }

  /** Motor 2 — visitas dos últimos 30d somadas por item (org-wide ou de 1 catálogo). */
  private async visits30dByItem(orgId: string, catalogRef?: string): Promise<Map<string, number>> {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
    let q = supabaseAdmin
      .from('radar_visit_snapshots')
      .select('item_id,visits')
      .eq('organization_id', orgId)
      .gte('visit_date', since)
    if (catalogRef) q = q.eq('catalog_product_ref', catalogRef)
    const { data } = await q
    const m = new Map<string, number>()
    for (const v of data ?? []) {
      const k = v.item_id as string
      m.set(k, (m.get(k) ?? 0) + (Number(v.visits) || 0))
    }
    return m
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface Calibration {
  calc_date: string | null
  org_rate: number | null
  org_confidence: 'ok' | 'low'
  org_visits: number
  org_units: number
  by_category: Map<string, { rate: number | null; confidence: 'ok' | 'low' }>
}

/** Resolve a conversão de um produto: a taxa da categoria se confiável, senão a org-wide. */
function effectiveRate(
  cal: Calibration,
  categoryId: string | null,
): { rate: number | null; basis: 'categoria' | 'organização' | 'indisponível' } {
  if (categoryId) {
    const c = cal.by_category.get(categoryId)
    if (c && c.confidence === 'ok' && c.rate != null) return { rate: c.rate, basis: 'categoria' }
  }
  if (cal.org_rate != null) return { rate: cal.org_rate, basis: 'organização' }
  return { rate: null, basis: 'indisponível' }
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const r of rows) {
    const k = key(r)
    const arr = m.get(k)
    if (arr) arr.push(r)
    else m.set(k, [r])
  }
  return m
}

function numbers(values: unknown[]): number[] {
  return values.filter((v): v is number => typeof v === 'number')
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback
}

/** Supabase devolve relação aninhada como array OU objeto — normaliza. */
function oneOf<T>(rel: T | T[] | null | undefined): T | null {
  if (rel == null) return null
  return Array.isArray(rel) ? (rel[0] ?? null) : rel
}

/** Δ% do menor preço de cada catálogo: data mais recente vs a anterior. */
function computeMinPriceDeltas(
  snaps: Array<{ catalog_product_ref: string; price: number | null; collected_at: string }>,
): Map<string, number> {
  const byCp = groupBy(snaps, (s) => s.catalog_product_ref)
  const out = new Map<string, number>()
  for (const [cp, rows] of byCp) {
    const minByDate = new Map<string, number>()
    for (const r of rows) {
      if (r.price == null) continue
      const d = r.collected_at.slice(0, 10)
      const cur = minByDate.get(d)
      if (cur === undefined || r.price < cur) minByDate.set(d, r.price)
    }
    const dates = [...minByDate.keys()].sort()
    if (dates.length < 2) continue
    const latest = minByDate.get(dates[dates.length - 1])!
    const prior = minByDate.get(dates[dates.length - 2])!
    if (prior > 0) out.set(cp, Math.round(((latest - prior) / prior) * 10_000) / 10_000)
  }
  return out
}
