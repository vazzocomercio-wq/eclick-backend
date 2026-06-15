import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { round2, computeContributionMargin } from '../../../common/margin'
import { ChannelSettingsService } from '../../channel-settings/channel-settings.service'
import { ShopeeListingLinkService } from '../shopee-sync/shopee-listing-link.service'
import { CampaignMarginService } from './campaign-margin.service'
import { MarketplaceService } from '../marketplace.service'
import { ShopeeProductSyncService } from '../shopee-sync/shopee-product-sync.service'
import { ShopeeAdapter } from '../adapters/shopee.adapter'

/** F18 Marketing inteligente — o "cérebro" e-Click sobre o marketing Shopee.
 *
 *  NÃO recria a tela da Shopee: recomenda, de forma margem-aware e IA-ready,
 *  QUAIS produtos colocar em Oferta Relâmpago / Cupom / Desconto, com QUAL
 *  desconto, mirando 4 objetivos (girar estoque, dar visibilidade, maximizar
 *  lucro, oportunidade de mercado) — SEMPRE respeitando o piso de margem
 *  (organizations.min_campaign_margin_pct). Reusa getLinkStatus (item+produto+
 *  margem), CampaignMarginService (projeção pós-desconto) e a comissão do canal.
 *
 *  Bloco 1+2 da proposta (recomendação + simulação). O "aplicar de verdade"
 *  (criar a promo via API) depende de escopo Shopee (probe abaixo). */
@Injectable()
export class ShopeeMarketingService {
  private readonly logger = new Logger(ShopeeMarketingService.name)

  /** Objetivos suportados (pesos iguais quando ≥1 selecionado). */
  static readonly OBJECTIVES = ['overstock', 'visibility', 'profit', 'opportunity'] as const

  constructor(
    private readonly channelSettings: ChannelSettingsService,
    private readonly link:            ShopeeListingLinkService,
    private readonly margin:          CampaignMarginService,
    private readonly mp:              MarketplaceService,
    private readonly productSync:     ShopeeProductSyncService,
  ) {}

  /** PROBE de escopo do módulo de promoções (Flash Sale). ok=false + 403 →
   *  o app não tem permissão de gestão de promoções (ação no Open Platform
   *  Console + re-OAuth, igual ao Ads). Informa se o "aplicar de verdade" roda. */
  async scopeProbe(orgId: string): Promise<{ flash_sale: { authorized: boolean; detail: string } }> {
    const resolved = await this.mp.resolve(orgId, 'shopee')
    if (!resolved?.conn?.shop_id) throw new NotFoundException('Loja Shopee não conectada nesta organização')
    const conn = await this.productSync.ensureFreshToken(resolved.conn)
    const adapter = resolved.adapter as ShopeeAdapter
    const r = await adapter.getFlashSaleTimeSlots(conn)
    return {
      flash_sale: {
        authorized: r.ok,
        detail: r.ok
          ? `OK — ${r.slots.length} time slots disponíveis nos próximos 7 dias.`
          : `Bloqueado (${r.error}). Habilite o módulo de promoções no Open Platform Console + re-OAuth da loja (igual ao Ads).`,
      },
    }
  }

  /** F18 Bloco 3 — APLICAR de verdade: cria um Desconto na Shopee pro anúncio,
   *  com `discountPct` de OFF por variação. Guard de margem (nunca abaixo do
   *  piso). 403-aware (escopo write → msg acionável). dryRun só simula; o
   *  desconto nasce AGENDADO (start +1h) — deleteAfter cria+remove pro teste. */
  async applyDiscount(orgId: string, itemId: number, discountPct: number, opts?: { dryRun?: boolean; deleteAfter?: boolean }): Promise<{
    ok: boolean; vehicle: 'discount'; discount_id?: number; deleted?: boolean
    models: Array<{ model_id: number; original_price: number; promotion_price: number; margin_pct: number }>
    dry_run?: boolean
  }> {
    const d = Math.round(Number(discountPct))
    if (!(d >= 1 && d <= 95)) throw new BadRequestException('Desconto inválido (1-95%)')

    // multi-conta: resolve a LOJA DONA do item (via account_id do listing)
    const { data: ownerPl } = await supabaseAdmin
      .from('product_listings')
      .select('account_id')
      .eq('platform', 'shopee').eq('listing_id', String(itemId))
      .limit(1).maybeSingle<{ account_id: string }>()
    const all = await this.mp.resolveAll(orgId, 'shopee')
    if (!all.length) throw new NotFoundException('Loja Shopee não conectada nesta organização')
    const ownerShop = ownerPl?.account_id ? Number(ownerPl.account_id) : all[0].conn.shop_id
    const chosen = all.find(r => r.conn.shop_id === ownerShop) ?? all[0]
    const conn = await this.productSync.ensureFreshToken(chosen.conn)
    const adapter = chosen.adapter as ShopeeAdapter
    const shopId = conn.shop_id!

    // produto vinculado (custo/imposto) p/ o guard de margem
    const { data: pl } = await supabaseAdmin
      .from('product_listings')
      .select('product_id')
      .eq('platform', 'shopee').eq('account_id', String(shopId)).eq('listing_id', String(itemId))
      .limit(1).maybeSingle<{ product_id: string }>()
    if (!pl?.product_id) throw new BadRequestException('Anúncio sem produto vinculado — vincule antes de promover (pra garantir a margem).')
    const { data: prod } = await supabaseAdmin
      .from('products').select('cost_price, tax_percentage, tax_on_freight')
      .eq('id', pl.product_id).maybeSingle<{ cost_price: number | null; tax_percentage: number | null; tax_on_freight: boolean | null }>()
    const cost = prod?.cost_price != null ? Number(prod.cost_price) : null
    if (cost == null || cost <= 0) throw new BadRequestException('Produto sem custo cadastrado — sem custo não dá pra garantir a margem da promoção.')

    const commissionPct = await this.channelSettings.getEstimatedTakeRatePct(orgId, 'shopee', 0)
    const { data: org } = await supabaseAdmin.from('organizations').select('min_campaign_margin_pct').eq('id', orgId).maybeSingle<{ min_campaign_margin_pct: number | null }>()
    const floorPct = org?.min_campaign_margin_pct ?? 8

    // models reais (preço de lista) via inspect. Anúncio COM variação → 1 por
    // model; SEM variação (has_model=false) → não há models, o preço vive no
    // ITEM (base_price_info) → trata como 1 "model" item-level (model_id 0).
    const inspect = await adapter.inspectItemStock(conn, itemId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawModels = ((inspect.models as any)?.model ?? []) as any[]
    const mkModel = (model_id: number, original: number) => {
      const promo = round2(original * (1 - d / 100))
      const mm = computeContributionMargin({
        price: promo, saleFee: round2(promo * commissionPct / 100), shipping: 0,
        cost, taxPercentage: prod?.tax_percentage ?? 0, taxOnFreight: prod?.tax_on_freight ?? false,
      })
      return { model_id, original_price: original, promotion_price: promo, margin_pct: mm.contributionMarginPct }
    }
    let models = rawModels
      .map(m => mkModel(Number(m?.model_id ?? 0), Number(m?.price_info?.[0]?.original_price ?? m?.price_info?.[0]?.current_price ?? 0)))
      .filter(m => m.original_price > 0)
    // fallback item-level (sem variação)
    if (!models.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bp = (inspect.base_price_info as any)?.[0]
      const itemPrice = Number(bp?.original_price ?? bp?.current_price ?? 0)
      if (itemPrice > 0) models = [mkModel(0, itemPrice)]
    }

    if (!models.length) throw new BadRequestException('Não foi possível ler o preço deste anúncio na Shopee.')
    // GUARD: nenhuma variação pode ficar abaixo do piso de margem
    const below = models.find(m => m.margin_pct < floorPct)
    if (below) throw new BadRequestException(`Desconto ${d}% derruba a margem de uma variação pra ${below.margin_pct.toFixed(1)}% (piso ${floorPct}%). Reduza o desconto.`)

    if (opts?.dryRun) return { ok: true, vehicle: 'discount', models, dry_run: true }

    // cria o desconto (agendado: +1h, dura 7 dias) — wrap 403-aware
    const nowSec = Math.floor(Date.now() / 1000)
    const startTime = nowSec + 3600
    const endTime = startTime + 7 * 86400
    let discountId: number | null = null
    try {
      const created = await adapter.addDiscount(conn, { name: `e-Click ${d}%OFF ${itemId}`.slice(0, 25), startTime, endTime })
      discountId = created.discount_id
      await adapter.addDiscountItems(conn, { discountId, itemId, models: models.map(m => ({ model_id: m.model_id, promotion_price: m.promotion_price })) })
    } catch (e: unknown) {
      // falha parcial: se o desconto foi criado mas os itens falharam, remove o órfão
      if (discountId != null) {
        try { await adapter.deleteDiscount(conn, discountId) } catch (de) { this.logger.warn(`[shopee.mkt] limpeza órfão discount=${discountId} falhou: ${(de as Error)?.message}`) }
      }
      const status = axios.isAxiosError(e) ? e.response?.status : undefined
      const msg = (e as Error)?.message ?? ''
      if (status === 403 || /403|forbidden|no permission|not authorized/i.test(msg)) {
        throw new BadRequestException(
          'Shopee bloqueou a criação de promoções com 403 — o app e-Click não tem escopo de gestão de Marketing/Promoções autorizado. ' +
          'É autorização no Open Platform Console (habilitar Marketing + re-OAuth da loja), igual ao Ads. ' +
          'Enquanto isso, use o plano recomendado e aplique na tela da Shopee.',
        )
      }
      throw new BadRequestException(`Falha ao criar o desconto na Shopee: ${msg}`)
    }

    if (opts?.deleteAfter) {
      try { await adapter.deleteDiscount(conn, discountId) } catch (e) { this.logger.warn(`[shopee.mkt] deleteAfter falhou discount=${discountId}: ${(e as Error)?.message}`) }
      return { ok: true, vehicle: 'discount', discount_id: discountId, deleted: true, models }
    }

    // Bloco 5 — registra a promoção aplicada (pro loop de outcome)
    const minMargin = Math.min(...models.map(m => m.margin_pct))
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin.schema('shopee') as any).from('applied_promotions').insert({
        organization_id: orgId, shop_id: shopId, item_id: itemId, product_id: pl.product_id,
        vehicle: 'discount', discount_pct: d,
        effective_price: models[0]?.promotion_price ?? null,
        projected_margin_pct: round2(minMargin),
        external_id: String(discountId),
        window_start: new Date(startTime * 1000).toISOString(),
        window_end:   new Date(endTime * 1000).toISOString(),
        status: 'active',
      })
    } catch (e) { this.logger.warn(`[shopee.mkt] registro applied_promotions falhou: ${(e as Error)?.message}`) }

    this.logger.log(`[shopee.mkt] APLICOU desconto org=${orgId} item=${itemId} d=${d}% discount_id=${discountId}`)
    return { ok: true, vehicle: 'discount', discount_id: discountId, models }
  }

  /** F18 Bloco 3 — cancela/remove um Desconto (rollback de promoção). */
  async cancelDiscount(orgId: string, discountId: number): Promise<{ ok: true }> {
    // multi-conta: o desconto pertence à loja registrada em applied_promotions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: promo } = await (supabaseAdmin.schema('shopee') as any).from('applied_promotions')
      .select('shop_id').eq('organization_id', orgId).eq('external_id', String(discountId)).limit(1).maybeSingle()
    const all = await this.mp.resolveAll(orgId, 'shopee')
    if (!all.length) throw new NotFoundException('Loja Shopee não conectada nesta organização')
    const shop = promo?.shop_id ? Number(promo.shop_id) : all[0].conn.shop_id
    const chosen = all.find(r => r.conn.shop_id === shop) ?? all[0]
    const conn = await this.productSync.ensureFreshToken(chosen.conn)
    const adapter = chosen.adapter as ShopeeAdapter
    await adapter.deleteDiscount(conn, discountId)
    // marca a promoção como cancelada (loop de outcome)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin.schema('shopee') as any).from('applied_promotions')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('organization_id', orgId).eq('external_id', String(discountId))
    } catch (e) { this.logger.warn(`[shopee.mkt] update cancel applied_promotions falhou: ${(e as Error)?.message}`) }
    this.logger.log(`[shopee.mkt] desconto cancelado org=${orgId} discount_id=${discountId}`)
    return { ok: true }
  }

  /** Recomendações de marketing. objectives = subconjunto de OBJECTIVES (default
   *  todos). Retorna ranking margem-safe por anúncio vinculado. */
  async recommend(orgId: string, objectives?: string[], limit = 50): Promise<{
    floor_pct:        number
    commission_pct:   number
    objectives:       string[]
    total_candidates: number
    already_promoted: number
    recommendations:  MarketingRecommendation[]
    warnings:         string[]
  }> {
    const warnings: string[] = []
    const objs = (objectives && objectives.length
      ? objectives.filter(o => (ShopeeMarketingService.OBJECTIVES as readonly string[]).includes(o))
      : [...ShopeeMarketingService.OBJECTIVES])
    if (!objs.length) objs.push(...ShopeeMarketingService.OBJECTIVES)

    // 1) anúncios vinculados + produto + margem (reuso do keystone)
    const status = await this.link.getLinkStatus(orgId)
    const commissionPct = await this.channelSettings.getEstimatedTakeRatePct(orgId, 'shopee', 0)
    if (commissionPct === 0) {
      warnings.push('Comissão Shopee = 0% (Configurações › Canais). As margens estão otimistas; o piso de margem só fica real com a comissão configurada.')
    }

    // piso de margem da org
    const { data: org } = await supabaseAdmin
      .from('organizations')
      .select('min_campaign_margin_pct')
      .eq('id', orgId)
      .maybeSingle<{ min_campaign_margin_pct: number | null }>()
    const floorPct = org?.min_campaign_margin_pct ?? 8

    // 2) velocidade de venda 60d por produto (orders source='shopee')
    const since = new Date(Date.now() - 60 * 86400 * 1000).toISOString()
    const salesByProduct = new Map<string, number>()
    {
      const { data: ordRows } = await supabaseAdmin
        .from('orders')
        .select('product_id, quantity, created_at')
        .eq('source', 'shopee')
        .gte('created_at', since)
        .not('product_id', 'is', null)
        .limit(5000)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const r of (ordRows ?? []) as any[]) {
        const pid = r.product_id as string
        salesByProduct.set(pid, (salesByProduct.get(pid) ?? 0) + (Number(r.quantity) || 0))
      }
    }

    // 2.1) itens JÁ em campanha ATIVA (aplicada via e-Click) → não recomendar de
    // novo (some da lista; aparece na aba Resultados). Evita oferecer promoção
    // pra produto que já está em promoção (e o re-apply falharia na Shopee).
    const nowIso = new Date().toISOString()
    const promotedItems = new Set<number>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: activePromos } = await (supabaseAdmin.schema('shopee') as any)
      .from('applied_promotions')
      .select('item_id, window_end')
      .eq('organization_id', orgId)
      .eq('status', 'active')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const p of (activePromos ?? []) as any[]) {
      if (!p.window_end || String(p.window_end) > nowIso) promotedItems.add(Number(p.item_id))
    }

    // 3) avalia cada anúncio LINKADO com margem, PULANDO os já em campanha ativa
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const linkedItems = (status.items as any[]).filter(i => i.linked && i.product && i.price > 0 && !promotedItems.has(Number(i.item_id)))
    const recs: MarketingRecommendation[] = []

    for (const it of linkedItems) {
      const price  = Number(it.price)
      const cost   = it.product.cost_price != null ? Number(it.product.cost_price) : null
      const stock  = it.product.stock != null ? Number(it.product.stock) : 0
      const score  = it.algo_score != null ? Number(it.algo_score) : null
      const taxPct = it.margin?.tax_amount != null && price > 0 ? 0 : 0 // imposto entra via evaluate (org default); usamos 0 explícito aqui
      const velocity60 = salesByProduct.get(it.product.id) ?? 0

      if (cost == null || cost <= 0) continue // sem custo não dá pra garantir margem

      // desconto máximo que mantém margem ≥ piso (fechado; shipping 0)
      const k = commissionPct / 100
      const t = (it.product?.tax_percentage != null ? Number(it.product.tax_percentage) : 0) / 100
      const denom = 1 - k - t - floorPct / 100
      let maxSafePct = 0
      if (denom > 0) {
        const minPrice = cost / denom
        maxSafePct = Math.max(0, Math.floor((1 - minPrice / price) * 100))
      }
      maxSafePct = Math.min(maxSafePct, 90)

      // ── scores por objetivo (0-100) ──
      // overstock: muitos meses de estoque (estoque / venda mensal)
      const monthlyVel = velocity60 / 2
      const monthsStock = stock > 0 ? stock / Math.max(monthlyVel, 0.5) : 0
      const overstock = clamp(Math.round((monthsStock / 6) * 100), 0, 100)
      // visibility: score baixo = mais necessidade
      const visibility = score != null ? clamp(100 - score, 0, 100) : 50
      // profit: espaço de desconto saudável (headroom)
      const profit = clamp(maxSafePct * 2, 0, 100)
      // opportunity: sinal de Radar (sem dado → neutro 0)
      const opportunity = 0

      const scoreByObj: Record<string, number> = { overstock, visibility, profit, opportunity }
      const priority = Math.round(objs.reduce((s, o) => s + (scoreByObj[o] ?? 0), 0) / objs.length)

      // objetivo dominante (entre os selecionados) → define veículo + cap de desconto
      const dominant = objs.slice().sort((a, b) => (scoreByObj[b] ?? 0) - (scoreByObj[a] ?? 0))[0]
      const vehicle: PromoVehicle =
        dominant === 'overstock' || dominant === 'opportunity' ? 'flash_sale'
          : dominant === 'visibility' ? 'voucher'
            : 'discount'
      const cap = dominant === 'overstock' ? 30 : dominant === 'visibility' ? 20 : 15
      const recommendedPct = Math.min(maxSafePct, cap)

      if (recommendedPct < 3) {
        // margem muito apertada p/ desconto relevante — registra mas despriorizado
        warnings.length // noop
      }

      // projeção de margem no desconto recomendado (motor canônico)
      const sim = await this.margin.evaluate(orgId, {
        price,
        discount_pct: recommendedPct / 100,
        shopee_commission_pct: k,
        cost,
        tax_percentage: it.product?.tax_percentage ?? undefined,
      })

      recs.push({
        item_id:        Number(it.item_id),
        title:          it.title ?? null,
        thumbnail:      it.thumbnail ?? null,
        product_id:     it.product.id,
        sku:            it.product.sku ?? null,
        price,
        cost,
        algo_score:     score,
        stock,
        sales_60d:      velocity60,
        months_of_stock: round2(monthsStock),
        max_safe_discount_pct: maxSafePct,
        recommended: {
          vehicle,
          discount_pct:   recommendedPct,
          effective_price: sim.effective_price,
          projected_margin_pct: sim.net_margin_pct,
          passes_floor:   sim.passes_gate,
        },
        objective_scores: { overstock, visibility, profit, opportunity },
        priority,
        rationale: this.rationale(vehicle, dominant, { recommendedPct, maxSafePct, monthsStock, score, projMargin: sim.net_margin_pct, floorPct }),
      })
    }

    recs.sort((a, b) => b.priority - a.priority)

    return {
      floor_pct:        floorPct,
      commission_pct:   commissionPct,
      objectives:       objs,
      total_candidates: linkedItems.length,
      already_promoted: promotedItems.size,
      recommendations:  recs.slice(0, limit),
      warnings,
    }
  }

  /** F18 Bloco 5 — Loop de outcome: mede o efeito de cada promoção aplicada
   *  (venda na janela × baseline da janela equivalente anterior) + custo de
   *  margem (desconto concedido × unidades vendidas). Persiste o outcome e
   *  devolve o ranking. "melhora sempre": alimenta as próximas recomendações. */
  async getOutcomes(orgId: string): Promise<{ outcomes: PromoOutcome[] }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rows } = await (supabaseAdmin.schema('shopee') as any)
      .from('applied_promotions')
      .select('*')
      .eq('organization_id', orgId)
      .order('applied_at', { ascending: false })
      .limit(100)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promos = (rows ?? []) as any[]
    const nowMs = Date.now()
    const out: PromoOutcome[] = []

    for (const p of promos) {
      const pStart = p.window_start ? new Date(p.window_start).getTime() : new Date(p.applied_at).getTime()
      const pEnd   = Math.min(p.window_end ? new Date(p.window_end).getTime() : nowMs, nowMs)
      const dur    = Math.max(pEnd - pStart, 86400000) // mín 1 dia p/ baseline
      const bEnd   = pStart
      const bStart = pStart - dur

      const started = pEnd > pStart // a janela já começou?
      const promoUnits    = started ? await this.sumShopeeSales(p.product_id, new Date(pStart).toISOString(), new Date(pEnd).toISOString()) : 0
      const baselineUnits = await this.sumShopeeSales(p.product_id, new Date(bStart).toISOString(), new Date(bEnd).toISOString())

      const liftUnits = promoUnits - baselineUnits
      const liftPct = baselineUnits > 0 ? round2((liftUnits / baselineUnits) * 100) : (promoUnits > 0 ? 100 : 0)
      // custo de margem ≈ desconto por unidade × unidades vendidas na promo
      const eff = Number(p.effective_price) || 0
      const d = Number(p.discount_pct) || 0
      const perUnitDiscount = d > 0 && d < 100 ? round2(eff * (d / 100) / (1 - d / 100)) : 0
      const marginCost = round2(perUnitDiscount * promoUnits)

      const verdict: PromoOutcome['verdict'] =
        !started ? 'pending'
          : liftUnits > 0 ? 'positive'
            : liftUnits < 0 ? 'negative'
              : 'neutral'

      const outcome: PromoOutcome = {
        id: p.id, item_id: Number(p.item_id), product_id: p.product_id, vehicle: p.vehicle,
        discount_pct: d, status: p.status,
        window_start: p.window_start, window_end: p.window_end, applied_at: p.applied_at,
        baseline_units: baselineUnits, promo_units: promoUnits, lift_units: liftUnits, lift_pct: liftPct,
        margin_cost: marginCost, verdict,
      }
      out.push(outcome)

      // persiste o outcome medido (não-fatal)
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabaseAdmin.schema('shopee') as any).from('applied_promotions')
          .update({ outcome: { baseline_units: baselineUnits, promo_units: promoUnits, lift_pct: liftPct, margin_cost: marginCost, verdict, measured_at: new Date(nowMs).toISOString() }, updated_at: new Date(nowMs).toISOString() })
          .eq('id', p.id)
      } catch { /* noop */ }
    }
    return { outcomes: out }
  }

  /** Soma unidades vendidas (orders source='shopee') de um produto numa janela. */
  private async sumShopeeSales(productId: string | null, fromIso: string, toIso: string): Promise<number> {
    if (!productId) return 0
    const { data } = await supabaseAdmin
      .from('orders')
      .select('quantity, created_at')
      .eq('source', 'shopee')
      .eq('product_id', productId)
      .gte('created_at', fromIso)
      .lt('created_at', toIso)
      .limit(2000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((data ?? []) as any[]).reduce((s, r) => s + (Number(r.quantity) || 0), 0)
  }

  private rationale(vehicle: PromoVehicle, dominant: string, x: {
    recommendedPct: number; maxSafePct: number; monthsStock: number; score: number | null; projMargin: number; floorPct: number
  }): string {
    const vh = vehicle === 'flash_sale' ? 'Oferta Relâmpago' : vehicle === 'voucher' ? 'Cupom' : 'Desconto'
    const why =
      dominant === 'overstock'   ? `estoque alto (~${x.monthsStock.toFixed(1)} meses de venda) — promover gira o parado`
        : dominant === 'visibility' ? `Algorithm Score baixo (${x.score ?? '—'}) — promoção dá tração e ranqueia`
          : dominant === 'profit'     ? `boa folga de margem (até ${x.maxSafePct}% de desconto cabem) — volume sem sacrificar lucro`
            : `oportunidade de mercado`
    return `${vh} com ${x.recommendedPct}% OFF: ${why}. Margem projetada ${x.projMargin.toFixed(1)}% (piso ${x.floorPct}%). Teto seguro: ${x.maxSafePct}% OFF.`
  }
}

type PromoVehicle = 'flash_sale' | 'voucher' | 'discount'

export interface MarketingRecommendation {
  item_id:    number
  title:      string | null
  thumbnail:  string | null
  product_id: string
  sku:        string | null
  price:      number
  cost:       number
  algo_score: number | null
  stock:      number
  sales_60d:  number
  months_of_stock: number
  max_safe_discount_pct: number
  recommended: {
    vehicle:              PromoVehicle
    discount_pct:         number
    effective_price:      number
    projected_margin_pct: number
    passes_floor:         boolean
  }
  objective_scores: { overstock: number; visibility: number; profit: number; opportunity: number }
  priority:   number
  rationale:  string
}

export interface PromoOutcome {
  id:            string
  item_id:       number
  product_id:    string | null
  vehicle:       string
  discount_pct:  number
  status:        string
  window_start:  string | null
  window_end:    string | null
  applied_at:    string
  baseline_units: number
  promo_units:   number
  lift_units:    number
  lift_pct:      number
  margin_cost:   number
  verdict:       'pending' | 'positive' | 'neutral' | 'negative'
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}
