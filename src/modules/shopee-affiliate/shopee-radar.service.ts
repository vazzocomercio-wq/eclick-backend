import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'
import { OpportunityScoreService } from './opportunity-score.service'
import { ShopeeAffiliateApiService, ProductOffer } from './shopee-affiliate-api.service'

type BuyDecision = 'comprar' | 'observar' | 'ignorar'
const AI_TOP_N = 25

/** F18 Sprint 2 — Radar de Produtos Campeões Shopee.
 *
 *  Ingere produtos reais da Affiliate API (vendas, comissão, nota, desconto),
 *  pontua (Champion Score — sourcing) e recomenda comprar/observar/ignorar com
 *  racional IA. Mais forte que o radar ML: aqui as VENDAS são reais. */
@Injectable()
export class ShopeeRadarService {
  private readonly logger = new Logger(ShopeeRadarService.name)

  constructor(
    private readonly api: ShopeeAffiliateApiService,
    private readonly opportunity: OpportunityScoreService,
    private readonly llm: LlmService,
  ) {}

  // ── Ingestão ───────────────────────────────────────────────────────────────

  async ingest(orgId: string, args: { keywords?: string[]; catIds?: number[]; pagesPerQuery?: number }): Promise<{
    fetched: number; upserted: number; scored: number; errors: string[]
  }> {
    if (!(await this.api.hasCreds(orgId))) {
      throw new BadRequestException('Conecte a Shopee Affiliate API (App ID/Secret) primeiro.')
    }
    const pages = Math.min(args.pagesPerQuery ?? 2, 5)
    const errors: string[] = []
    const byItem = new Map<number, ProductOffer>()

    // queries: cada keyword, cada categoria, e o top-vendas global
    const queries: { keyword?: string; catId?: number }[] = []
    for (const k of (args.keywords ?? [])) queries.push({ keyword: k })
    for (const c of (args.catIds ?? [])) queries.push({ catId: c })
    if (!queries.length) queries.push({})   // global top-sales

    for (const q of queries) {
      for (let page = 1; page <= pages; page++) {
        try {
          const { offers, hasNext } = await this.api.productOffers({ orgId, keyword: q.keyword, catId: q.catId, sortType: 2, page, limit: 50 })
          for (const o of offers) if (o.itemId) byItem.set(o.itemId, o)
          if (!hasNext) break
        } catch (e) {
          errors.push(`${q.keyword ?? q.catId ?? 'global'} p${page}: ${e instanceof Error ? e.message : e}`)
          break
        }
      }
    }

    const offers = [...byItem.values()]
    // ordena por vendas pra priorizar racional IA nos campeões
    offers.sort((a, b) => (b.sales ?? 0) - (a.sales ?? 0))

    let upserted = 0, scored = 0
    for (let i = 0; i < offers.length; i++) {
      const o = offers[i]
      const champion = this.championScore(o, null)        // momentum calculado no próximo run
      const decision = this.decide(champion, o.ratingStar)
      const opp = this.opportunity.compute({
        item_id: o.itemId, shop_id: o.shopId, name: o.productName, category: String(o.productCatIds?.[0] ?? ''),
        price_cents: Math.round(o.price * 100), commission_rate: o.commissionRate, rating: o.ratingStar,
        sales_volume: o.sales, seller_score: null, trend_score: champion,
      })
      const rationale = (i < AI_TOP_N && decision !== 'ignorar')
        ? await this.aiRationale(orgId, o, champion, decision)
        : this.templateRationale(o, champion, decision)

      const { error } = await supabaseAdmin.schema('shopee').from('affiliate_offers').upsert({
        organization_id: orgId,
        item_id:         o.itemId,
        shop_id:         o.shopId,
        name:            o.productName,
        category:        String(o.productCatIds?.[0] ?? ''),
        price_cents:     Math.round(o.price * 100),
        commission_rate: o.commissionRate,
        rating:          o.ratingStar,
        sales_volume:    o.sales,
        discount_pct:    o.priceDiscountRate,
        opportunity_score: opp.score,
        champion_score:  champion,
        buy_decision:    decision,
        ai_rationale:    rationale,
        conv_estimate:   opp.conv_estimate,
        product_link:    o.productLink,
        offer_link:      o.offerLink,
        image_url:       o.imageUrl,
        raw:             o as unknown as Record<string, unknown>,
        fetched_at:      new Date().toISOString(),
        source:          'product_offer',
      }, { onConflict: 'organization_id,item_id' })
      if (error) { errors.push(`upsert ${o.itemId}: ${error.message}`); continue }
      upserted++

      // série temporal (histórico p/ análise)
      await supabaseAdmin.schema('shopee').from('offer_signals').insert({
        organization_id: orgId, item_id: o.itemId, sales: o.sales,
        price_cents: Math.round(o.price * 100), discount_pct: o.priceDiscountRate,
        rating: o.ratingStar, commission_rate: o.commissionRate, champion_score: champion,
      })
      scored++
    }

    // persiste as keywords usadas (pro cron diário repetir a busca)
    if (args.keywords?.length) {
      await supabaseAdmin.schema('shopee').from('affiliate_connections')
        .update({ radar_keywords: args.keywords }).eq('organization_id', orgId)
    }

    this.logger.log(`[shopee.radar] org=${orgId} fetched=${byItem.size} upserted=${upserted} scored=${scored}`)
    return { fetched: byItem.size, upserted, scored, errors }
  }

  // ── Config + cron diário ─────────────────────────────────────────────────

  async getSettings(orgId: string): Promise<{ auto: boolean; keywords: string[]; connected: boolean }> {
    const { data } = await supabaseAdmin.schema('shopee').from('affiliate_connections')
      .select('status, radar_auto, radar_keywords').eq('organization_id', orgId).maybeSingle()
    const row = data as { status: string | null; radar_auto: boolean | null; radar_keywords: string[] | null } | null
    return { auto: !!row?.radar_auto, keywords: row?.radar_keywords ?? [], connected: row?.status === 'active' }
  }

  async saveSettings(orgId: string, patch: { auto?: boolean; keywords?: string[] }): Promise<{ ok: true }> {
    const upd: Record<string, unknown> = {}
    if (patch.auto != null)     upd.radar_auto = patch.auto
    if (patch.keywords != null) upd.radar_keywords = patch.keywords
    if (Object.keys(upd).length) {
      await supabaseAdmin.schema('shopee').from('affiliate_connections')
        .update(upd).eq('organization_id', orgId)
    }
    return { ok: true }
  }

  /** Orgs com auto-ingestão ligada (pro worker diário). */
  async autoIngestOrgs(): Promise<{ orgId: string; keywords: string[] }[]> {
    const { data } = await supabaseAdmin.schema('shopee').from('affiliate_connections')
      .select('organization_id, radar_keywords').eq('status', 'active').eq('radar_auto', true)
    return ((data ?? []) as { organization_id: string; radar_keywords: string[] | null }[])
      .map(r => ({ orgId: r.organization_id, keywords: r.radar_keywords ?? [] }))
  }

  // ── Observar (watchlist) — monitoramento diário garantido por itemId ─────────

  async setWatch(orgId: string, itemId: number, watched: boolean): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin.schema('shopee').from('affiliate_offers')
      .update({ watched }).eq('organization_id', orgId).eq('item_id', itemId)
    if (error) throw new BadRequestException(error.message)
    // ao observar, captura na hora pra começar a série (não espera o cron)
    if (watched) { try { await this.refreshItem(orgId, itemId) } catch { /* best-effort */ } }
    return { ok: true }
  }

  /** Orgs que têm ≥1 produto observado (pro cron). */
  async orgsWithWatched(): Promise<string[]> {
    const { data } = await supabaseAdmin.schema('shopee').from('affiliate_offers')
      .select('organization_id').eq('watched', true)
    return [...new Set(((data ?? []) as { organization_id: string }[]).map(r => r.organization_id))]
  }

  /** Re-busca todos os produtos observados de uma org pelo itemId (garante
   *  histórico mesmo se saírem do top-vendas). Roda no cron diário. */
  async refreshWatched(orgId: string): Promise<{ refreshed: number }> {
    const { data } = await supabaseAdmin.schema('shopee').from('affiliate_offers')
      .select('item_id').eq('organization_id', orgId).eq('watched', true)
    const ids = ((data ?? []) as { item_id: number }[]).map(r => r.item_id)
    let refreshed = 0
    for (const id of ids) { if (await this.refreshItem(orgId, id)) refreshed++ }
    return { refreshed }
  }

  /** Captura UM item agora: busca pelo itemId, recomputa champion (com momentum
   *  vs venda anterior), atualiza a oferta e grava o ponto na série. */
  private async refreshItem(orgId: string, itemId: number): Promise<boolean> {
    const o = await this.api.productById(orgId, itemId)
    if (!o) return false
    // venda anterior pro momentum
    const { data: prev } = await supabaseAdmin.schema('shopee').from('offer_signals')
      .select('sales').eq('organization_id', orgId).eq('item_id', itemId)
      .order('captured_at', { ascending: false }).limit(1).maybeSingle()
    const prevSales = (prev as { sales: number | null } | null)?.sales ?? null
    const champion = this.championScore(o, prevSales)
    const decision = this.decide(champion, o.ratingStar)

    await supabaseAdmin.schema('shopee').from('affiliate_offers').update({
      sales_volume: o.sales, price_cents: Math.round(o.price * 100), discount_pct: o.priceDiscountRate,
      rating: o.ratingStar, commission_rate: o.commissionRate, champion_score: champion,
      buy_decision: decision, fetched_at: new Date().toISOString(),
    }).eq('organization_id', orgId).eq('item_id', itemId)

    await supabaseAdmin.schema('shopee').from('offer_signals').insert({
      organization_id: orgId, item_id: itemId, sales: o.sales,
      price_cents: Math.round(o.price * 100), discount_pct: o.priceDiscountRate,
      rating: o.ratingStar, commission_rate: o.commissionRate, champion_score: champion,
    })
    return true
  }

  // ── Champion Score (sourcing) ────────────────────────────────────────────────

  private championScore(o: ProductOffer, prevSales: number | null): number {
    // vendas REAIS (peso maior) — escala log-ish
    const s = o.sales ?? 0
    const salesScore = s >= 3000 ? 100 : s >= 500 ? 70 + ((s - 500) / 2500) * 30
      : s >= 50 ? 30 + ((s - 50) / 450) * 40 : (s / 50) * 30
    // nota
    const ratingScore = o.ratingStar != null ? (clamp(o.ratingStar, 0, 5) / 5) * 100 : 50
    // comissão (sinal de push do vendedor/Shopee + ganho afiliado)
    const r = clamp(o.commissionRate ?? 0, 0, 1)
    const commissionScore = r >= 0.15 ? 100 : (r / 0.15) * 100
    // momentum: crescimento de vendas vs captura anterior (neutro sem histórico)
    let momentum = 50
    if (prevSales != null && prevSales > 0) {
      const growth = (s - prevSales) / prevSales
      momentum = clamp(50 + growth * 200, 0, 100)   // +25% vendas/dia → ~100
    }
    const score = 0.50 * salesScore + 0.20 * ratingScore + 0.20 * momentum + 0.10 * commissionScore
    return Math.round(score * 10) / 10
  }

  private decide(champion: number, rating: number | null): BuyDecision {
    if (rating != null && rating < 4.0) return champion >= 40 ? 'observar' : 'ignorar'  // nota baixa = risco
    if (champion >= 65) return 'comprar'
    if (champion >= 40) return 'observar'
    return 'ignorar'
  }

  // ── Racional IA ──────────────────────────────────────────────────────────────

  private async aiRationale(orgId: string, o: ProductOffer, champion: number, decision: BuyDecision): Promise<string> {
    const sys =
      'Você é um analista de sourcing de e-commerce brasileiro. Recebe os números reais de um produto ' +
      'campeão de vendas na Shopee e escreve uma recomendação curta e acionável sobre comprar para revender. ' +
      'Direto, pt-BR, máximo 2 frases, texto corrido (sem JSON/markdown). Como ainda não temos o custo do ' +
      'fornecedor, SEMPRE lembre de validar a margem com a cotação antes de fechar.'
    const usr = JSON.stringify({
      produto: o.productName, vendas_reais: o.sales, preco_brl: o.price, desconto_pct: o.priceDiscountRate,
      nota: o.ratingStar, comissao_pct: Math.round((o.commissionRate ?? 0) * 100), loja: o.shopName,
      champion_score: champion, decisao_sugerida: decision,
    })
    try {
      const out = await this.llm.generateText({ orgId, feature: 'trends_buy_decision', systemPrompt: sys, userPrompt: usr, maxTokens: 220, temperature: 0.4 })
      const txt = (out.text ?? '').trim()
      if (txt.length >= 10) return txt.slice(0, 600)
    } catch (e) {
      this.logger.warn(`[shopee.radar] IA racional falhou item ${o.itemId}: ${e instanceof Error ? e.message : e}`)
    }
    return this.templateRationale(o, champion, decision)
  }

  private templateRationale(o: ProductOffer, champion: number, decision: BuyDecision): string {
    const head = decision === 'comprar' ? 'Forte candidato' : decision === 'observar' ? 'Vale acompanhar' : 'Sinal fraco'
    return `${head}: ${o.sales ?? 0} vendas, nota ${o.ratingStar ?? '—'}, ${o.priceDiscountRate ?? 0}% off. Valide o custo do fornecedor antes de comprar.`
  }

  // ── Leitura ────────────────────────────────────────────────────────────────

  async radar(args: { orgId: string; decision?: BuyDecision | null; minScore?: number | null; watched?: boolean; limit: number; offset: number }) {
    let q = supabaseAdmin.schema('shopee').from('affiliate_offers')
      .select('*', { count: 'exact' })
      .eq('organization_id', args.orgId)
      .order('champion_score', { ascending: false, nullsFirst: false })
      .range(args.offset, args.offset + args.limit - 1)
    if (args.decision)         q = q.eq('buy_decision', args.decision)
    if (args.minScore != null) q = q.gte('champion_score', args.minScore)
    if (args.watched)          q = q.eq('watched', true)
    const { data, count, error } = await q
    if (error) throw new BadRequestException(error.message)
    return { items: data ?? [], total: count ?? 0 }
  }

  async productAnalytics(orgId: string, itemId: number, days: number) {
    const { data: offer } = await supabaseAdmin.schema('shopee').from('affiliate_offers')
      .select('*').eq('organization_id', orgId).eq('item_id', itemId).maybeSingle()
    if (!offer) throw new BadRequestException('Produto não encontrado no radar')

    const since = new Date(Date.now() - days * 86400_000).toISOString()
    const { data: sigs } = await supabaseAdmin.schema('shopee').from('offer_signals')
      .select('sales, price_cents, discount_pct, rating, commission_rate, champion_score, captured_at')
      .eq('organization_id', orgId).eq('item_id', itemId).gte('captured_at', since)
      .order('captured_at', { ascending: true })
    const rows = (sigs ?? []) as { sales: number | null; price_cents: number | null; discount_pct: number | null; rating: number | null; champion_score: number | null; captured_at: string }[]

    const ser = (key: 'sales' | 'price_cents' | 'discount_pct' | 'rating' | 'champion_score') =>
      rows.filter(r => r[key] != null).map(r => ({ date: r.captured_at, value: r[key] as number }))

    // velocidade de vendas (delta entre 1ª e última captura)
    const salesPts = ser('sales')
    let salesVelocity: number | null = null
    if (salesPts.length >= 2) {
      const span = (new Date(salesPts[salesPts.length - 1].date).getTime() - new Date(salesPts[0].date).getTime()) / 86400_000
      if (span > 0) salesVelocity = Math.round(((salesPts[salesPts.length - 1].value - salesPts[0].value) / span) * 10) / 10
    }

    return {
      offer,
      points: rows.length,
      salesVelocity,                       // vendas/dia (real, acumula no cron)
      series: {
        sales:    salesPts,
        price:    ser('price_cents'),
        discount: ser('discount_pct'),
        rating:   ser('rating'),
        score:    ser('champion_score'),
      },
      days,
    }
  }

  async affiliateLink(orgId: string, itemId: number): Promise<{ link: string | null }> {
    const { data } = await supabaseAdmin.schema('shopee').from('affiliate_offers')
      .select('product_link, offer_link').eq('organization_id', orgId).eq('item_id', itemId).maybeSingle()
    const row = data as { product_link: string | null; offer_link: string | null } | null
    if (row?.offer_link) return { link: row.offer_link }
    if (row?.product_link) return { link: await this.api.generateAffiliateLink(orgId, row.product_link) }
    return { link: null }
  }
}

function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)) }
