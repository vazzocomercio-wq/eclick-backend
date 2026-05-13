import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { AlertSignalsService } from '../../intelligence-hub/alert-signals.service'
import { MercadolivreService } from '../../mercadolivre/mercadolivre.service'
import type { SignalDraft } from '../../intelligence-hub/analyzers/analyzers.types'

const ML_BASE = 'https://api.mercadolibre.com'

/**
 * Notifier que cria 1 alert_signal por venda nova com payload rico:
 * - Valores (preço, custo, tarifa, frete, imposto, margem)
 * - Trend de vendas do produto (últimos 7d vs 7d-14d anteriores)
 * - ADS ativo no anúncio (se houver) + métricas agregadas
 * - Taxa de conversão do produto (vendas / visitas, 7d)
 *
 * É invocado em fire-and-forget pelo `ingestSingleOrder` após o upsert
 * de um pedido `status='paid'`. Toda computação é SQL (sem ML calls
 * adicionais) — lê de orders, ml_ads_campaigns/reports e ml_items_visits_daily.
 *
 * Aparece no AlertToastListener (top-right do dashboard) via socket
 * `intelligence:alert`, category='new_sale', severity='info'.
 */
@Injectable()
export class NewSaleNotifierService {
  private readonly logger = new Logger(NewSaleNotifierService.name)

  constructor(
    private readonly alertSignals: AlertSignalsService,
    private readonly ml:           MercadolivreService,
  ) {}

  /** Dispara em fire-and-forget. Falha silenciosa — não derruba o ingest. */
  fireAndForget(orgId: string, sellerId: number, externalOrderId: string | number): void {
    void this.compose(orgId, sellerId, externalOrderId).catch(err => {
      this.logger.warn(`[new-sale-notify] order=${externalOrderId}: ${(err as Error).message}`)
    })
  }

  private async compose(orgId: string, sellerId: number, externalOrderId: string | number): Promise<void> {
    // 0. Idempotência — ML manda múltiplos webhooks pra mesmo pedido
    // (created → paid → shipped → delivered). Sem essa guard, o
    // ingestSingleOrder dispara o notifier toda vez e geramos 3-5
    // toasts duplicados pra mesma venda. Caso real Vazzo 2026-05-13:
    // pedido 2000016418354960 gerou 4 toasts em 50s.
    // Guard: se já existe um alert_signal category='new_sale' pra esse
    // order_id nas últimas 24h, skipa silenciosamente.
    const orderIdStr = String(externalOrderId)
    const { data: existing } = await supabaseAdmin
      .from('alert_signals')
      .select('id')
      .eq('organization_id', orgId)
      .eq('category', 'new_sale')
      .filter('data->>order_id', 'eq', orderIdStr)
      .gte('created_at', new Date(Date.now() - 24 * 3600_000).toISOString())
      .limit(1)
      .maybeSingle()
    if (existing) {
      this.logger.debug(`[new-sale-notify] order=${orderIdStr} já notificado — skip (idempotência)`)
      return
    }

    // 1. Lê o pedido recém-upsertado
    const { data: order } = await supabaseAdmin
      .from('orders')
      .select(`
        id, external_order_id, status, sold_at, product_title, sku,
        product_id, marketplace_listing_id, raw_data,
        quantity, sale_price, platform_fee, cost_price, tax_amount,
        shipping_cost, shipping_buyer_paid,
        contribution_margin, contribution_margin_pct
      `)
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .eq('external_order_id', String(externalOrderId))
      .limit(1)
      .maybeSingle()

    if (!order) return
    if ((order as { status?: string }).status !== 'paid') return

    const o = order as Record<string, unknown>
    const productId  = (o.product_id as string | null) ?? null
    const listingId  = (o.marketplace_listing_id as string | null)
      ?? this.extractFirstListingId(o.raw_data)

    // 2. Compose em paralelo (inclui fetch da thumbnail do ML)
    const [trend, ads, conversion, thumbnail] = await Promise.all([
      this.computeTrend(orgId, sellerId, productId, listingId),
      this.fetchAds(orgId, listingId),
      this.computeConversion(orgId, sellerId, listingId),
      this.fetchThumbnail(orgId, sellerId, listingId),
    ])

    // 2b. Origem da venda — inferida dos tags do raw_data (zero custo)
    const source = this.classifySource(o.raw_data)

    // 3. Valores
    const qty       = Number(o.quantity ?? 1)
    const unitPrice = Number(o.sale_price ?? 0)
    const total     = unitPrice * qty
    const cost      = Number(o.cost_price ?? 0)
    const tarifa    = Number(o.platform_fee ?? 0)
    const freteVend = Number(o.shipping_cost ?? 0)
    const tax       = Number(o.tax_amount ?? 0)
    const margemBrl = o.contribution_margin != null
      ? Number(o.contribution_margin)
      : Math.round((total - cost - tarifa - freteVend - tax) * 100) / 100
    const margemPct = o.contribution_margin_pct != null
      ? Number(o.contribution_margin_pct)
      : (total > 0 ? Math.round((margemBrl / total) * 10000) / 100 : 0)

    const title = String(o.product_title ?? '').trim() || `Venda ${externalOrderId}`

    // 4. Summary curto (toast compacto) + suggestion (toast hover)
    const summary = qty > 1
      ? `${qty}× ${title} · R$ ${total.toFixed(2)} · margem ${margemPct.toFixed(1)}%`
      : `${title} · R$ ${total.toFixed(2)} · margem ${margemPct.toFixed(1)}%`

    const suggestion = this.composeSuggestion({ trend, ads, conversion, margemPct, source })

    // 5. Severity: 'info' default; 'warning' se margem baixa OU venda com prejuízo
    const severity = margemPct < 0 ? 'warning' : margemPct < 10 ? 'warning' : 'info'
    const score = margemPct < 0 ? 75 : margemPct < 10 ? 55 : 25

    const draft: SignalDraft = {
      analyzer:      'ml',
      category:      'new_sale',
      severity:      severity as SignalDraft['severity'],
      score,
      entity_type:   'product' as SignalDraft['entity_type'],
      entity_id:     productId ?? listingId ?? String(externalOrderId),
      entity_name:   title,
      summary_pt:    summary,
      suggestion_pt: suggestion,
      data: {
        order_id:           externalOrderId,
        ml_item_id:         listingId,
        product_id:         productId,
        sku:                o.sku ?? null,
        sold_at:            o.sold_at ?? null,
        thumbnail,
        source,
        values: {
          quantity:        qty,
          unit_price:      unitPrice,
          total:           total,
          cost:            cost,
          tarifa_ml:       tarifa,
          frete_vendedor:  freteVend,
          imposto:         tax,
          margem_brl:      margemBrl,
          margem_pct:      margemPct,
        },
        trend,
        ads,
        conversion,
      },
      expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
    }

    await this.alertSignals.insertMany(orgId, [draft])
  }

  // ── Classifica origem da venda lendo raw_data (zero custo) ──────────────
  /**
   * ML NÃO retorna no /orders/{id} se a venda veio de campanha ADS ou via
   * afiliado — esses dados ficam em APIs separadas (Advertising attribution,
   * Partners API). Aqui usamos o que está disponível:
   *
   * - `tags: ['catalog']` → venda via catálogo ML (busca/lista canônica)
   * - sem catalog       → comprou pela página do anúncio direto
   * - `b2b`             → comprador empresa
   * - `bundle`          → kit/combo
   * - `pack_order`      → pedido com múltiplos items no carrinho
   * - `order_has_discount` → cupom aplicado
   *
   * `ads_attribution` requer cross-check com tabela própria de
   * attribution (não preenchida hoje). Quando estiver, posso adicionar
   * direto aqui — campo já está reservado no payload.
   */
  private classifySource(raw: unknown): {
    channel: 'catalog' | 'direct_listing'
    tags:    string[]
    is_b2b:        boolean
    is_kit:        boolean
    is_pack:       boolean
    has_discount:  boolean
    /** Reservado pra quando ml-ads-attribution sync estiver ativo */
    ads_attribution: { is_ads: boolean; source?: 'unknown' } | null
  } {
    const tags: string[] = Array.isArray((raw as { tags?: string[] } | null | undefined)?.tags)
      ? ((raw as { tags: string[] }).tags ?? [])
      : []
    const tagSet = new Set(tags)
    return {
      channel:        tagSet.has('catalog') ? 'catalog' : 'direct_listing',
      tags,
      is_b2b:         tagSet.has('b2b'),
      is_kit:         tagSet.has('bundle'),
      is_pack:        tagSet.has('pack_order'),
      has_discount:   tagSet.has('order_has_discount'),
      ads_attribution: null,  // TODO: cross-check com ml_ads_attributed_sales quando sync existir
    }
  }

  // ── Thumbnail do ML (com cache em product_listings.listing_thumbnail) ────
  private async fetchThumbnail(orgId: string, sellerId: number, listingId: string | null): Promise<string | null> {
    if (!listingId) return null

    // 1. Cache hit em product_listings
    const { data: cached } = await supabaseAdmin
      .from('product_listings')
      .select('listing_thumbnail')
      .eq('listing_id', listingId)
      .eq('platform', 'mercadolivre')
      .limit(1)
      .maybeSingle()
    const cachedUrl = (cached as { listing_thumbnail: string | null } | null)?.listing_thumbnail
    if (cachedUrl) return this.upgradeToHttps(cachedUrl)

    // 2. Cache miss → fetch ML + grava no cache pra próximas vendas serem instantâneas
    try {
      const { token } = await this.ml.getTokenForOrg(orgId, sellerId)
      const { data } = await axios.get(`${ML_BASE}/items/${listingId}`, {
        headers: { Authorization: `Bearer ${token}` },
        params:  { attributes: 'id,thumbnail,secure_thumbnail' },
        timeout: 5000,
      })
      const url = data?.secure_thumbnail || data?.thumbnail
      if (typeof url !== 'string' || !url) return null

      // Atualiza cache (best-effort — não bloqueia retorno)
      void supabaseAdmin
        .from('product_listings')
        .update({ listing_thumbnail: url, updated_at: new Date().toISOString() })
        .eq('listing_id', listingId)
        .eq('platform', 'mercadolivre')

      return this.upgradeToHttps(url)
    } catch (err) {
      this.logger.debug(`[new-sale-notify] fetchThumbnail ${listingId}: ${(err as Error).message}`)
      return null
    }
  }

  /** ML às vezes devolve thumbnail em http:// — força https pra não ter
   *  mixed content na UI (Netlify é https). */
  private upgradeToHttps(url: string): string {
    return url.startsWith('http://') ? url.replace('http://', 'https://') : url
  }

  // ── Trend: vendas 7d vs 7d-14d anteriores do mesmo produto ───────────────
  private async computeTrend(
    orgId: string,
    sellerId: number,
    productId: string | null,
    listingId: string | null,
  ): Promise<{ sales_7d: number; sales_prev_7d: number; delta_pct: number; direction: 'up' | 'down' | 'flat' } | null> {
    if (!productId && !listingId) return null
    const now    = new Date()
    const sevenAgo  = new Date(now.getTime() - 7 * 86400_000).toISOString()
    const fourteenAgo = new Date(now.getTime() - 14 * 86400_000).toISOString()

    const buildCountQuery = (fromIso: string, toIso?: string) => {
      let qq = supabaseAdmin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .eq('seller_id', sellerId)
        .eq('status', 'paid')
        .gte('sold_at', fromIso)
      if (toIso) qq = qq.lt('sold_at', toIso)
      if (productId)      qq = qq.eq('product_id', productId)
      else if (listingId) qq = qq.eq('marketplace_listing_id', listingId)
      return qq
    }

    const [curRes, prevRes] = await Promise.all([
      buildCountQuery(sevenAgo),
      buildCountQuery(fourteenAgo, sevenAgo),
    ])
    const cur  = curRes.count ?? 0
    const prev = prevRes.count ?? 0
    const delta = prev === 0
      ? (cur > 0 ? 100 : 0)
      : Math.round(((cur - prev) / prev) * 100)
    const direction: 'up' | 'down' | 'flat' =
      Math.abs(delta) < 5 ? 'flat' : delta > 0 ? 'up' : 'down'
    return { sales_7d: cur, sales_prev_7d: prev, delta_pct: delta, direction }
  }

  // ── Ads: campanha ativa que contém esse listing ──────────────────────────
  private async fetchAds(orgId: string, listingId: string | null): Promise<{
    has_active_campaign: boolean
    campaign_name?:      string | null
    campaign_id?:        string | null
    clicks_7d?:          number
    impressions_7d?:     number
    ctr_pct?:            number | null
    cost_7d?:            number | null
  } | null> {
    if (!listingId) return { has_active_campaign: false }

    const { data: camps } = await supabaseAdmin
      .from('ml_ads_campaigns')
      .select('id, name, status, items')
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .limit(50)
    const found = ((camps ?? []) as Array<{ id: string; name: string; items: string[] | null }>)
      .find(c => Array.isArray(c.items) && c.items.includes(listingId))
    if (!found) return { has_active_campaign: false }

    const sevenAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10)
    const { data: reports } = await supabaseAdmin
      .from('ml_ads_reports')
      .select('clicks, impressions, ctr, cost')
      .eq('campaign_id', found.id)
      .gte('date', sevenAgo)
    let clicks = 0, imps = 0, cost = 0
    for (const r of (reports ?? []) as Array<{ clicks?: number; impressions?: number; cost?: number }>) {
      clicks += Number(r.clicks ?? 0)
      imps   += Number(r.impressions ?? 0)
      cost   += Number(r.cost ?? 0)
    }
    const ctr = imps > 0 ? Math.round((clicks / imps) * 10000) / 100 : null

    return {
      has_active_campaign: true,
      campaign_name:       found.name,
      campaign_id:         found.id,
      clicks_7d:           clicks,
      impressions_7d:      imps,
      ctr_pct:             ctr,
      cost_7d:             Math.round(cost * 100) / 100,
    }
  }

  // ── Conversão: vendas 7d / visitas 7d do mesmo listing ───────────────────
  private async computeConversion(
    orgId: string,
    sellerId: number,
    listingId: string | null,
  ): Promise<{ visits_7d: number; sales_7d: number; rate_pct: number | null } | null> {
    if (!listingId) return null
    const sevenAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10)
    const sevenAgoIso = new Date(Date.now() - 7 * 86400_000).toISOString()

    const [visitsRes, salesRes] = await Promise.all([
      supabaseAdmin
        .from('ml_items_visits_daily')
        .select('visits')
        .eq('organization_id', orgId)
        .eq('seller_id', sellerId)
        .eq('item_id', listingId)
        .gte('date', sevenAgo),
      supabaseAdmin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .eq('seller_id', sellerId)
        .eq('marketplace_listing_id', listingId)
        .eq('status', 'paid')
        .gte('sold_at', sevenAgoIso),
    ])
    const visits = ((visitsRes.data ?? []) as Array<{ visits: number }>)
      .reduce((s, r) => s + Number(r.visits ?? 0), 0)
    const sales = salesRes.count ?? 0
    const rate = visits > 0 ? Math.round((sales / visits) * 10000) / 100 : null
    return { visits_7d: visits, sales_7d: sales, rate_pct: rate }
  }

  private extractFirstListingId(raw: unknown): string | null {
    if (!raw || typeof raw !== 'object') return null
    const o = raw as { item?: { id?: unknown }; order_items?: unknown[] }
    if (o.item && typeof o.item === 'object') {
      const id = (o.item as { id?: unknown }).id
      if (typeof id === 'string') return id
    }
    if (Array.isArray(o.order_items)) {
      for (const it of o.order_items) {
        if (it && typeof it === 'object') {
          const i = it as { item_id?: unknown; item?: { id?: unknown } }
          if (typeof i.item_id === 'string') return i.item_id
          const nested = i.item?.id
          if (typeof nested === 'string') return nested
        }
      }
    }
    return null
  }

  private composeSuggestion(ctx: {
    trend:      Awaited<ReturnType<NewSaleNotifierService['computeTrend']>>
    ads:        Awaited<ReturnType<NewSaleNotifierService['fetchAds']>>
    conversion: Awaited<ReturnType<NewSaleNotifierService['computeConversion']>>
    margemPct:  number
    source:     ReturnType<NewSaleNotifierService['classifySource']>
  }): string {
    const parts: string[] = []

    // Origem
    const originParts: string[] = [
      ctx.source.channel === 'catalog' ? '📦 Catálogo ML' : '🏷️ Anúncio direto',
    ]
    if (ctx.source.is_b2b)        originParts.push('B2B')
    if (ctx.source.is_kit)        originParts.push('Kit')
    if (ctx.source.is_pack)       originParts.push('Carrinho')
    if (ctx.source.has_discount)  originParts.push('Cupom')
    parts.push(originParts.join(' · '))

    if (ctx.trend) {
      const arrow = ctx.trend.direction === 'up' ? '↑' : ctx.trend.direction === 'down' ? '↓' : '→'
      parts.push(`Vendas 7d: ${ctx.trend.sales_7d} ${arrow} (${ctx.trend.delta_pct >= 0 ? '+' : ''}${ctx.trend.delta_pct}% vs 7d ant)`)
    }
    if (ctx.conversion?.rate_pct != null) {
      parts.push(`Conversão: ${ctx.conversion.rate_pct.toFixed(2)}% (${ctx.conversion.sales_7d}/${ctx.conversion.visits_7d} visits)`)
    }
    if (ctx.ads?.has_active_campaign) {
      const ctrStr = ctx.ads.ctr_pct != null ? ` · CTR ${ctx.ads.ctr_pct}%` : ''
      const costStr = ctx.ads.cost_7d ? ` · R$ ${ctx.ads.cost_7d.toFixed(2)} gasto 7d` : ''
      parts.push(`📢 ADS ativo: ${ctx.ads.campaign_name}${ctrStr}${costStr}`)
    } else {
      parts.push('Sem campanha ADS ativa')
    }
    if (ctx.margemPct < 10) {
      parts.unshift('⚠ Margem baixa — revisar custo ou preço')
    }
    return parts.join(' · ')
  }
}
