import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { round2, computeContributionMargin } from '../../../common/margin'
import { ChannelSettingsService } from '../../channel-settings/channel-settings.service'
import { CampaignMarginService } from './campaign-margin.service'
import { MarketplaceService } from '../marketplace.service'
import { ShopeeProductSyncService } from '../shopee-sync/shopee-product-sync.service'
import { ShopeeListingLinkService } from '../shopee-sync/shopee-listing-link.service'
import { ShopeeCampaignsSyncService } from '../shopee-sync/shopee-campaigns-sync.service'
import { ShopeeAdapter } from '../adapters/shopee.adapter'
import { MpConnection } from '../adapters/base'
import { LlmService } from '../../ai/llm.service'

/** F18 — Campaign Center vira ESCRITA: criar Voucher (cupom) e Oferta
 *  Relâmpago (shop flash sale) direto do painel, SEMPRE passando pela trava
 *  de margem (CampaignMarginService + comissão real do canal).
 *
 *  Regra da trava (por item, na margem LÍQUIDA projetada pós-desconto):
 *    < 0%  → BLOQUEADO (não cria, explica o porquê)
 *    0-5%  → WARNING (só cria com accept_warning=true — confirmação extra na UI)
 *    ≥ 5%  → ok
 *  O piso da org (min_campaign_margin_pct) aparece como contexto no preview.
 *
 *  Gate de produção: env SHOPEE_PROMO_WRITE=on libera os writes (default OFF —
 *  preview/sugestão funcionam sempre). Probe 2026-06-12 confirmou que o app
 *  TEM permissão nos módulos voucher + shop_flash_sale (≠ Ads/add_item). */
@Injectable()
export class ShopeePromoWriteService {
  private readonly logger = new Logger(ShopeePromoWriteService.name)

  constructor(
    private readonly mp:              MarketplaceService,
    private readonly productSync:     ShopeeProductSyncService,
    private readonly link:            ShopeeListingLinkService,
    private readonly margin:          CampaignMarginService,
    private readonly channelSettings: ChannelSettingsService,
    private readonly campaignsSync:   ShopeeCampaignsSyncService,
    private readonly llm:             LlmService,
  ) {}

  private writeEnabled(): boolean {
    return (process.env.SHOPEE_PROMO_WRITE ?? 'off').toLowerCase() === 'on'
  }

  private ensureWriteEnabled(): void {
    if (!this.writeEnabled()) {
      throw new BadRequestException(
        'A criação de promoções pelo painel está desligada (gate SHOPEE_PROMO_WRITE). ' +
        'O preview de margem funciona normalmente; pra criar de verdade na Shopee, ligue o gate após validar um voucher de teste.',
      )
    }
  }

  /** Multi-conta: resolve a loja alvo. 1 conta = automática; 2+ sem shop_id
   *  explícito = 400 acionável com as opções (padrão do creative publish). */
  private async resolveShop(orgId: string, shopId?: number | null): Promise<{ conn: MpConnection; adapter: ShopeeAdapter }> {
    const all = await this.mp.resolveAll(orgId, 'shopee')
    if (!all.length) throw new NotFoundException('Nenhuma loja Shopee conectada nesta organização')
    let chosen = all[0]
    if (shopId != null) {
      const hit = all.find(r => r.conn.shop_id === Number(shopId))
      if (!hit) throw new BadRequestException(`Loja Shopee ${shopId} não encontrada nesta organização`)
      chosen = hit
    } else if (all.length > 1) {
      const opts = all.map(r => `${r.conn.shop_id} (${r.conn.nickname ?? 'sem nome'})`).join(', ')
      throw new BadRequestException(`Esta organização tem ${all.length} lojas Shopee — informe shop_id. Opções: ${opts}`)
    }
    const conn = await this.productSync.ensureFreshToken(chosen.conn)
    return { conn, adapter: chosen.adapter as ShopeeAdapter }
  }

  /** Lojas Shopee da org (pro seletor do wizard — sempre com nome). */
  async listShops(orgId: string): Promise<{ shops: Array<{ shop_id: number; nickname: string | null }>; write_enabled: boolean }> {
    const all = await this.mp.resolveAll(orgId, 'shopee')
    return {
      shops: all.filter(r => r.conn.shop_id != null).map(r => ({ shop_id: r.conn.shop_id!, nickname: r.conn.nickname ?? null })),
      write_enabled: this.writeEnabled(),
    }
  }

  /** Time slots de Oferta Relâmpago disponíveis (próximos 7 dias) da loja. */
  async listFlashSlots(orgId: string, shopId?: number | null): Promise<{ shop_id: number; slots: Array<{ timeslot_id: number; start_time: number; end_time: number }> }> {
    const { conn, adapter } = await this.resolveShop(orgId, shopId)
    const r = await adapter.getFlashSaleTimeSlots(conn)
    if (!r.ok) throw new BadRequestException(`Shopee não devolveu os horários de Oferta Relâmpago: ${r.error}`)
    return { shop_id: conn.shop_id!, slots: r.slots.map(s => ({ timeslot_id: Number(s.timeslot_id), start_time: Number(s.start_time), end_time: Number(s.end_time) })) }
  }

  // ── VOUCHER ────────────────────────────────────────────────────────────────

  /** Preview do voucher: margem líquida projetada POR ITEM da loja (ou dos
   *  itens selecionados, no voucher de produto). Desconto efetivo conservador:
   *  percentual = o próprio %; valor fixo = discount_amount sobre o pedido
   *  MÍNIMO (pior caso). Nada é criado. */
  async previewVoucher(orgId: string, input: VoucherInput): Promise<PromoPreview> {
    const effPct = this.voucherEffectivePct(input)
    const itemIds = input.voucher_type === 2 ? (input.item_ids ?? []) : null
    if (input.voucher_type === 2 && !itemIds?.length) throw new BadRequestException('Voucher de produto precisa de pelo menos 1 item (item_ids).')
    return this.previewByDiscount(orgId, input.shop_id ?? null, effPct, itemIds)
  }

  /** Cria o Voucher na Shopee (gate env + trava de margem). ⚠️ promoção REAL. */
  async createVoucher(orgId: string, input: VoucherInput & {
    name: string; code: string; start_time: number; end_time: number
    usage_quantity: number; accept_warning?: boolean
  }): Promise<{ ok: true; voucher_id: number; preview: PromoPreview }> {
    this.ensureWriteEnabled()
    // validações de shape (PT-BR acionável)
    const code = String(input.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!code || code.length > 5) throw new BadRequestException('Código do voucher: 1 a 5 letras/números (a Shopee prefixa com o código da loja).')
    const nowSec = Math.floor(Date.now() / 1000)
    if (!(input.start_time > nowSec - 60)) throw new BadRequestException('Início do voucher precisa ser no futuro.')
    if (!(input.end_time > input.start_time)) throw new BadRequestException('Fim do voucher precisa ser depois do início.')
    if (input.end_time - input.start_time > 120 * 86400) throw new BadRequestException('Período máximo do voucher: 120 dias.')
    if (!(Number(input.usage_quantity) >= 1)) throw new BadRequestException('Quantidade de uso (usage_quantity) precisa ser ≥ 1.')
    if (input.reward_type === 2 && !(Number(input.percentage) >= 1 && Number(input.percentage) <= 99)) {
      throw new BadRequestException('Desconto percentual precisa estar entre 1% e 99%.')
    }
    if (input.reward_type === 1 && !(Number(input.discount_amount) > 0)) {
      throw new BadRequestException('Desconto em R$ (discount_amount) precisa ser > 0.')
    }

    const preview = await this.previewVoucher(orgId, input)
    this.enforceGate(preview, input.accept_warning)

    const { conn, adapter } = await this.resolveShop(orgId, input.shop_id ?? null)
    let voucherId: number
    try {
      const created = await adapter.addVoucher(conn, {
        name:           input.name,
        code,
        startTime:      input.start_time,
        endTime:        input.end_time,
        voucherType:    input.voucher_type,
        rewardType:     input.reward_type,
        discountAmount: input.discount_amount,
        percentage:     input.percentage,
        maxPrice:       input.max_price,
        minBasketPrice: Math.max(0, Number(input.min_basket_price) || 0),
        usageQuantity:  Math.floor(Number(input.usage_quantity)),
        itemIdList:     input.item_ids,
      })
      voucherId = created.voucher_id
    } catch (e: unknown) {
      throw this.shopeeWriteError(e, 'voucher')
    }

    // registra no loop de outcome (item_id=0 = voucher de loja toda)
    await this.persistApplied(orgId, conn.shop_id!, 'voucher', String(voucherId), {
      itemIds: input.voucher_type === 2 ? (input.item_ids ?? []) : [0],
      discountPct: this.voucherEffectivePct(input),
      windowStart: input.start_time, windowEnd: input.end_time,
      preview,
    })
    this.refreshCampaigns(orgId)
    this.logger.log(`[shopee.promo] VOUCHER criado org=${orgId} shop=${conn.shop_id} voucher_id=${voucherId} (${input.reward_type === 2 ? `${input.percentage}%` : `R$${input.discount_amount}`})`)
    return { ok: true, voucher_id: voucherId, preview }
  }

  /** Encerra (ongoing) ou apaga (upcoming) um voucher. Rollback do create. */
  async endVoucher(orgId: string, voucherId: number, shopId?: number | null): Promise<{ ok: true; action: 'ended' | 'deleted' }> {
    this.ensureWriteEnabled()
    const resolvedShop = shopId ?? await this.shopOfPromo(orgId, 'voucher', String(voucherId))
    const { conn, adapter } = await this.resolveShop(orgId, resolvedShop)
    // upcoming usa delete; ongoing usa end — tenta end, cai pro delete
    let action: 'ended' | 'deleted' = 'ended'
    try {
      await adapter.endVoucher(conn, voucherId)
    } catch {
      await adapter.deleteVoucher(conn, voucherId)
      action = 'deleted'
    }
    await this.markCancelled(orgId, String(voucherId))
    this.refreshCampaigns(orgId)
    this.logger.log(`[shopee.promo] voucher ${action} org=${orgId} voucher_id=${voucherId}`)
    return { ok: true, action }
  }

  // ── FLASH SALE ─────────────────────────────────────────────────────────────

  /** Preview da Oferta Relâmpago: margem POR VARIAÇÃO de cada item no preço
   *  promocional proposto. Lê preço de lista real na Shopee. Nada é criado. */
  async previewFlashSale(orgId: string, shopId: number | null | undefined, items: FlashItemInput[]): Promise<PromoPreview & { items_detail: FlashItemDetail[] }> {
    if (!items?.length) throw new BadRequestException('Informe pelo menos 1 item pra Oferta Relâmpago.')
    if (items.length > 50) throw new BadRequestException('Máximo de 50 itens por Oferta Relâmpago.')
    const { conn } = await this.resolveShop(orgId, shopId)
    const detail = await this.flashItemsDetail(orgId, conn, items)
    const itemsPreview: PromoItemPreview[] = detail.map(d => ({
      item_id: d.item_id, title: d.title, price: d.models[0]?.original_price ?? null,
      projected_margin_pct: d.worst_margin_pct, verdict: verdictFor(d.worst_margin_pct),
    }))
    return { ...this.summarize(orgId, itemsPreview, await this.floorPct(orgId)), items_detail: detail }
  }

  /** Cria a Oferta Relâmpago (sessão no slot + itens). Gate env + trava de
   *  margem por variação. Rollback automático se nenhum item entrar. ⚠️ REAL. */
  async createFlashSale(orgId: string, input: {
    shop_id?: number | null; timeslot_id: number
    items: FlashItemInput[]; accept_warning?: boolean
  }): Promise<{ ok: true; flash_sale_id: number; failed_items: unknown[]; preview: PromoPreview }> {
    this.ensureWriteEnabled()
    if (!Number.isFinite(Number(input.timeslot_id))) throw new BadRequestException('timeslot_id inválido — escolha um horário disponível.')
    const { conn, adapter } = await this.resolveShop(orgId, input.shop_id ?? null)

    const detail = await this.flashItemsDetail(orgId, conn, input.items)
    const itemsPreview: PromoItemPreview[] = detail.map(d => ({
      item_id: d.item_id, title: d.title, price: d.models[0]?.original_price ?? null,
      projected_margin_pct: d.worst_margin_pct, verdict: verdictFor(d.worst_margin_pct),
    }))
    const preview = this.summarize(orgId, itemsPreview, await this.floorPct(orgId))
    this.enforceGate(preview, input.accept_warning)

    // janela do slot (pro registro de outcome)
    const slots = await adapter.getFlashSaleTimeSlots(conn)
    const slot = slots.ok ? slots.slots.find(s => Number(s.timeslot_id) === Number(input.timeslot_id)) : undefined

    let flashSaleId: number
    try {
      const created = await adapter.createShopFlashSale(conn, Number(input.timeslot_id))
      flashSaleId = created.flash_sale_id
    } catch (e: unknown) {
      throw this.shopeeWriteError(e, 'flash sale')
    }

    let failed: unknown[] = []
    try {
      const r = await adapter.addShopFlashSaleItems(conn, {
        flashSaleId,
        items: detail.map(d => ({
          item_id: d.item_id,
          purchase_limit: d.purchase_limit ?? 0,
          models: d.models.map(m => ({ model_id: m.model_id, input_promo_price: m.promotion_price, stock: m.promo_stock })),
        })),
      })
      failed = r.failed
    } catch (e: unknown) {
      // nenhum item entrou → remove a sessão órfã
      try { await adapter.deleteShopFlashSale(conn, flashSaleId) } catch (de) { this.logger.warn(`[shopee.promo] limpeza flash órfã ${flashSaleId} falhou: ${(de as Error)?.message}`) }
      throw this.shopeeWriteError(e, 'itens da flash sale')
    }
    if (Array.isArray(failed) && failed.length >= detail.length) {
      try { await adapter.deleteShopFlashSale(conn, flashSaleId) } catch { /* melhor esforço */ }
      throw new BadRequestException(`A Shopee recusou todos os ${detail.length} itens da Oferta Relâmpago: ${JSON.stringify(failed[0])?.slice(0, 200)}`)
    }

    await this.persistApplied(orgId, conn.shop_id!, 'flash_sale', String(flashSaleId), {
      itemIds: detail.map(d => d.item_id),
      discountPct: Math.max(...input.items.map(i => Number(i.discount_pct) || 0)),
      windowStart: slot ? Number(slot.start_time) : null, windowEnd: slot ? Number(slot.end_time) : null,
      preview,
    })
    this.refreshCampaigns(orgId)
    this.logger.log(`[shopee.promo] FLASH SALE criada org=${orgId} shop=${conn.shop_id} flash_sale_id=${flashSaleId} itens=${detail.length} falhas=${failed.length}`)
    return { ok: true, flash_sale_id: flashSaleId, failed_items: failed, preview }
  }

  /** Remove uma Oferta Relâmpago (rollback). */
  async deleteFlashSale(orgId: string, flashSaleId: number, shopId?: number | null): Promise<{ ok: true }> {
    this.ensureWriteEnabled()
    const resolvedShop = shopId ?? await this.shopOfPromo(orgId, 'flash_sale', String(flashSaleId))
    const { conn, adapter } = await this.resolveShop(orgId, resolvedShop)
    await adapter.deleteShopFlashSale(conn, flashSaleId)
    await this.markCancelled(orgId, String(flashSaleId))
    this.refreshCampaigns(orgId)
    this.logger.log(`[shopee.promo] flash sale removida org=${orgId} flash_sale_id=${flashSaleId}`)
    return { ok: true }
  }

  // ── IA — sugestão de % ideal por produto ──────────────────────────────────

  /** Sugere o % de desconto ideal por item (giro 60d × margem × folga segura),
   *  via LlmService (feature shopee_promo_suggest, jsonMode). Fallback
   *  determinístico se a IA falhar: min(teto seguro, cap por giro). */
  async suggestDiscount(orgId: string, itemIds: number[], vehicle: 'voucher' | 'flash_sale'): Promise<{
    suggestions: Array<{ item_id: number; suggested_pct: number; max_safe_pct: number; rationale: string }>
  }> {
    if (!itemIds?.length) throw new BadRequestException('Informe os itens (item_ids) pra sugerir desconto.')
    const status = await this.link.getLinkStatus(orgId)
    const commissionPct = await this.channelSettings.getCommissionPct(orgId, 'shopee', 0)
    const floor = await this.floorPct(orgId)
    const wanted = new Set(itemIds.map(Number))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (status.items as any[]).filter(i => wanted.has(Number(i.item_id)) && i.linked && i.product && i.price > 0)
    if (!rows.length) throw new BadRequestException('Nenhum dos itens está vinculado a produto com preço — vincule antes (a trava de margem precisa do custo).')

    // giro 60d por produto (orders source='shopee')
    const since = new Date(Date.now() - 60 * 86400 * 1000).toISOString()
    const { data: ordRows } = await supabaseAdmin
      .from('orders').select('product_id, quantity')
      .eq('source', 'shopee').gte('created_at', since)
      .in('product_id', rows.map(r => r.product.id)).limit(5000)
    const salesByProduct = new Map<string, number>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of (ordRows ?? []) as any[]) salesByProduct.set(r.product_id, (salesByProduct.get(r.product_id) ?? 0) + (Number(r.quantity) || 0))

    const facts = rows.map(r => {
      const price = Number(r.price)
      const cost = Number(r.product.cost_price) || 0
      const t = (Number(r.product.tax_percentage) || 0) / 100
      const k = commissionPct / 100
      // teto: maior desconto que ainda deixa margem ≥ 0 (a trava re-valida depois)
      const denom = 1 - k - t
      const maxSafe = cost > 0 && denom > 0 && price > 0 ? Math.max(0, Math.min(90, Math.floor((1 - (cost / denom) / price) * 100))) : 0
      return {
        item_id: Number(r.item_id), title: String(r.title ?? '').slice(0, 60),
        price, cost, margin_pct: r.margin?.contribution_margin_pct ?? null,
        stock: Number(r.product.stock) || 0, sales_60d: salesByProduct.get(r.product.id) ?? 0,
        max_safe_pct: maxSafe,
      }
    })

    const fallback = () => facts.map(f => {
      const slowMover = f.sales_60d < 5 && f.stock > 20
      const pct = Math.min(f.max_safe_pct, slowMover ? 25 : 12)
      return { item_id: f.item_id, suggested_pct: pct, max_safe_pct: f.max_safe_pct, rationale: slowMover ? 'Giro baixo com estoque alto — desconto mais agressivo pra girar (heurística).' : 'Giro saudável — desconto moderado preserva margem (heurística).' }
    })

    try {
      const out = await this.llm.generateText({
        orgId, feature: 'shopee_promo_suggest', jsonMode: true, maxTokens: 1500,
        systemPrompt:
          'Você é um estrategista de pricing de e-commerce brasileiro (Shopee). Recebe uma lista de produtos com preço, custo, ' +
          'margem atual, estoque, vendas em 60 dias e o desconto máximo seguro (max_safe_pct, que mantém margem ≥ 0). ' +
          `O veículo da promoção é ${vehicle === 'flash_sale' ? 'Oferta Relâmpago (pico curto de tráfego — desconto precisa ser perceptível, ≥10% quando couber)' : 'Cupom/Voucher (desconto contínuo — moderado preserva margem)'}. ` +
          `Piso de margem recomendado da empresa: ${floor}%. ` +
          'Responda APENAS JSON: {"suggestions":[{"item_id":number,"suggested_pct":number,"rationale":"1 frase em PT-BR"}]}. ' +
          'NUNCA sugira acima do max_safe_pct do item. Elasticidade: giro baixo + estoque alto → mais agressivo; giro alto → conservador.',
        userPrompt: JSON.stringify({ products: facts }),
      })
      // o modelo às vezes embrulha o JSON em cerca markdown (```json … ```)
      const cleaned = out.text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
      const parsed = JSON.parse(cleaned) as { suggestions?: Array<{ item_id: number; suggested_pct: number; rationale?: string }> }
      const byId = new Map(facts.map(f => [f.item_id, f]))
      const suggestions = (parsed.suggestions ?? [])
        .filter(s => byId.has(Number(s.item_id)))
        .map(s => {
          const f = byId.get(Number(s.item_id))!
          const pct = Math.max(0, Math.min(Math.round(Number(s.suggested_pct) || 0), f.max_safe_pct))
          return { item_id: f.item_id, suggested_pct: pct, max_safe_pct: f.max_safe_pct, rationale: String(s.rationale ?? '').slice(0, 300) }
        })
      if (!suggestions.length) return { suggestions: fallback() }
      // itens que a IA esqueceu entram com a heurística
      const got = new Set(suggestions.map(s => s.item_id))
      for (const f of fallback()) if (!got.has(f.item_id)) suggestions.push(f)
      return { suggestions }
    } catch (e) {
      this.logger.warn(`[shopee.promo] IA suggest falhou (usando heurística): ${(e as Error)?.message}`)
      return { suggestions: fallback() }
    }
  }

  // ── internos ───────────────────────────────────────────────────────────────

  /** % de desconto efetivo (conservador) de um voucher pro cálculo de margem. */
  private voucherEffectivePct(input: VoucherInput): number {
    if (input.reward_type === 2) return Math.max(0, Math.min(99, Number(input.percentage) || 0))
    const amount = Number(input.discount_amount) || 0
    const minBasket = Math.max(Number(input.min_basket_price) || 0, amount, 1)
    return Math.max(0, Math.min(100, round2((amount / minBasket) * 100)))
  }

  /** Margem projetada por item da loja (ou itens selecionados) pra um % de
   *  desconto único. Motor canônico CampaignMarginService + comissão real. */
  private async previewByDiscount(orgId: string, shopId: number | null, discountPct: number, itemIds: number[] | null): Promise<PromoPreview> {
    const status = await this.link.getLinkStatus(orgId)
    const commissionPct = await this.channelSettings.getCommissionPct(orgId, 'shopee', 0)
    const floor = await this.floorPct(orgId)
    const wanted = itemIds ? new Set(itemIds.map(Number)) : null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (status.items as any[]).filter(i =>
      i.linked && i.product && i.price > 0 && i.product.cost_price != null
      && (shopId == null || Number(i.shop_id) === Number(shopId))
      && (!wanted || wanted.has(Number(i.item_id))))
    if (!rows.length) {
      throw new BadRequestException(itemIds?.length
        ? 'Nenhum dos itens selecionados tem produto vinculado COM custo — a trava de margem precisa do custo cadastrado.'
        : 'Nenhum anúncio desta loja tem produto vinculado com custo — vincule em Catálogo › Anúncios Shopee antes de criar promoção.')
    }
    const items: PromoItemPreview[] = []
    for (const r of rows) {
      const sim = await this.margin.evaluate(orgId, {
        price: Number(r.price),
        discount_pct: discountPct / 100,
        shopee_commission_pct: commissionPct / 100,
        cost: Number(r.product.cost_price),
        tax_percentage: r.product.tax_percentage ?? undefined,
      })
      items.push({
        item_id: Number(r.item_id), title: r.title ?? null, price: Number(r.price),
        projected_margin_pct: sim.net_margin_pct, verdict: verdictFor(sim.net_margin_pct),
      })
    }
    return this.summarize(orgId, items, floor)
  }

  private summarize(_orgId: string, items: PromoItemPreview[], floorPct: number): PromoPreview {
    const blocked = items.filter(i => i.verdict === 'blocked')
    const warning = items.filter(i => i.verdict === 'warning')
    const verdict: PromoVerdict = blocked.length ? 'blocked' : warning.length ? 'warning' : 'ok'
    const worst = items.slice().sort((a, b) => a.projected_margin_pct - b.projected_margin_pct)[0]
    const name = (i?: PromoItemPreview) => i ? `"${(i.title ?? String(i.item_id)).slice(0, 50)}" (${i.projected_margin_pct.toFixed(1)}%)` : ''
    const message =
      verdict === 'blocked'
        ? `${blocked.length} de ${items.length} ite${items.length > 1 ? 'ns' : 'm'} ficaria${blocked.length > 1 ? 'm' : ''} com margem líquida NEGATIVA — ex: ${name(worst)}. Promoção bloqueada: reduza o desconto ou tire esses itens.`
        : verdict === 'warning'
          ? `${warning.length} ite${warning.length > 1 ? 'ns' : 'm'} fica${warning.length > 1 ? 'm' : ''} com margem entre 0% e 5% — ex: ${name(worst)}. Dá pra criar, mas confirme que vale a pena (margem quase zero).`
          : `Margens saudáveis: pior item ${name(worst)}. Piso recomendado da empresa: ${floorPct}%.`
    return {
      verdict, message, floor_pct: floorPct,
      total_items: items.length, blocked_count: blocked.length, warning_count: warning.length,
      items,
    }
  }

  private enforceGate(preview: PromoPreview, acceptWarning?: boolean): void {
    if (preview.verdict === 'blocked') throw new BadRequestException(preview.message)
    if (preview.verdict === 'warning' && !acceptWarning) {
      throw new BadRequestException(`${preview.message} (Pra criar mesmo assim, confirme o aviso — accept_warning.)`)
    }
  }

  private async floorPct(orgId: string): Promise<number> {
    const { data: org } = await supabaseAdmin
      .from('organizations').select('min_campaign_margin_pct')
      .eq('id', orgId).maybeSingle<{ min_campaign_margin_pct: number | null }>()
    return org?.min_campaign_margin_pct ?? 8
  }

  /** Detalha itens da flash sale: modelos reais (preço de lista + estoque) +
   *  preço promo + margem por variação. Valida vínculo/custo (trava). */
  private async flashItemsDetail(orgId: string, conn: MpConnection, items: FlashItemInput[]): Promise<FlashItemDetail[]> {
    const adapter = (await this.mp.resolveByShop(orgId, conn.shop_id!, 'shopee'))?.adapter as ShopeeAdapter
    const status = await this.link.getLinkStatus(orgId)
    const commissionPct = await this.channelSettings.getCommissionPct(orgId, 'shopee', 0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byItem = new Map((status.items as any[]).map(i => [Number(i.item_id), i]))
    const out: FlashItemDetail[] = []

    for (const it of items) {
      const itemId = Number(it.item_id)
      const d = Math.round(Number(it.discount_pct))
      if (!(d >= 1 && d <= 90)) throw new BadRequestException(`Item ${itemId}: desconto inválido (1-90%).`)
      const row = byItem.get(itemId)
      if (!row?.linked || row.product?.cost_price == null) {
        throw new BadRequestException(`Item ${itemId}${row?.title ? ` ("${String(row.title).slice(0, 40)}")` : ''} sem produto vinculado com custo — vincule antes (a trava de margem precisa do custo).`)
      }
      const cost = Number(row.product.cost_price)
      const taxPct = Number(row.product.tax_percentage) || 0

      const inspect = await adapter.inspectItemStock(conn, itemId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawModels = ((inspect.models as any)?.model ?? []) as any[]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const readStock = (m: any): number => Number(m?.stock_info_v2?.summary_info?.total_available_stock ?? 0)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mk = (model_id: number, original: number, available: number) => {
        const promo = round2(original * (1 - d / 100))
        const sim = this.simMargin(promo, commissionPct, cost, taxPct)
        return {
          model_id, original_price: original, promotion_price: promo,
          margin_pct: sim, available_stock: available,
          promo_stock: Math.max(1, Math.min(it.stock ?? available, available || (it.stock ?? 1))),
        }
      }
      let models = rawModels
        .map(m => mk(Number(m?.model_id ?? 0), Number(m?.price_info?.[0]?.original_price ?? m?.price_info?.[0]?.current_price ?? 0), readStock(m)))
        .filter(m => m.original_price > 0)
      if (!models.length) {
        // anúncio sem variação: preço/estoque no nível do item (model_id 0)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bp = (inspect.base_price_info as any)?.[0]
        const itemPrice = Number(bp?.original_price ?? bp?.current_price ?? 0)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const itemStock = Number((inspect.base_stock_info as any)?.summary_info?.total_available_stock ?? 0)
        if (itemPrice > 0) models = [mk(0, itemPrice, itemStock)]
      }
      if (!models.length) throw new BadRequestException(`Item ${itemId}: não consegui ler o preço na Shopee.`)

      out.push({
        item_id: itemId, title: row.title ?? null, discount_pct: d,
        purchase_limit: it.purchase_limit,
        models,
        worst_margin_pct: Math.min(...models.map(m => m.margin_pct)),
      })
    }
    return out
  }

  /** Margem líquida % de um preço promocional. Motor canônico margin.ts
   *  (mesmo do CampaignMarginService), síncrono — comissão/custo/imposto já
   *  resolvidos pelo caller (evita 1 ida ao banco por variação). */
  private simMargin(promoPrice: number, commissionPct: number, cost: number, taxPct: number): number {
    const m = computeContributionMargin({
      price: promoPrice, saleFee: round2(promoPrice * commissionPct / 100),
      shipping: 0, cost, taxPercentage: taxPct, taxOnFreight: false,
    })
    return m.contributionMarginPct
  }

  private shopeeWriteError(e: unknown, what: string): BadRequestException {
    const statusCode = axios.isAxiosError(e) ? e.response?.status : undefined
    const msg = (e as Error)?.message ?? ''
    if (statusCode === 403 || /403|forbidden|no permission|not authorized|error_api_permission/i.test(msg)) {
      return new BadRequestException(
        `A Shopee bloqueou a criação de ${what} com erro de permissão — o app e-Click precisa do módulo de promoções autorizado no Open Platform Console (+ re-OAuth da loja).`,
      )
    }
    return new BadRequestException(`Falha ao criar ${what} na Shopee: ${msg}`)
  }

  /** Loja dona de uma promoção registrada (pro end/delete multi-conta). */
  private async shopOfPromo(orgId: string, vehicle: string, externalId: string): Promise<number | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabaseAdmin.schema('shopee') as any).from('applied_promotions')
      .select('shop_id').eq('organization_id', orgId).eq('vehicle', vehicle)
      .eq('external_id', externalId).limit(1).maybeSingle()
    return data?.shop_id != null ? Number(data.shop_id) : null
  }

  private async persistApplied(orgId: string, shopId: number, vehicle: 'voucher' | 'flash_sale', externalId: string, x: {
    itemIds: number[]; discountPct: number
    windowStart: number | null; windowEnd: number | null
    preview: PromoPreview
  }): Promise<void> {
    try {
      const marginByItem = new Map(x.preview.items.map(i => [i.item_id, i.projected_margin_pct]))
      const rows = x.itemIds.map(itemId => ({
        organization_id: orgId, shop_id: shopId, item_id: itemId,
        vehicle, discount_pct: x.discountPct,
        projected_margin_pct: marginByItem.get(itemId) ?? null,
        external_id: externalId,
        window_start: x.windowStart ? new Date(x.windowStart * 1000).toISOString() : null,
        window_end:   x.windowEnd   ? new Date(x.windowEnd   * 1000).toISOString() : null,
        status: 'active',
      }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin.schema('shopee') as any).from('applied_promotions').insert(rows)
    } catch (e) { this.logger.warn(`[shopee.promo] registro applied_promotions falhou: ${(e as Error)?.message}`) }
  }

  private async markCancelled(orgId: string, externalId: string): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin.schema('shopee') as any).from('applied_promotions')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('organization_id', orgId).eq('external_id', externalId)
    } catch (e) { this.logger.warn(`[shopee.promo] markCancelled falhou: ${(e as Error)?.message}`) }
  }

  /** Re-sincroniza shopee.campaigns (fire-and-forget) pro Campaign Center
   *  mostrar a promoção nova sem esperar o próximo cron. */
  private refreshCampaigns(orgId: string): void {
    this.campaignsSync.syncCampaigns(orgId).catch(e =>
      this.logger.warn(`[shopee.promo] refresh campaigns falhou: ${(e as Error)?.message}`))
  }
}

type PromoVerdict = 'ok' | 'warning' | 'blocked'

function verdictFor(marginPct: number): PromoVerdict {
  return marginPct < 0 ? 'blocked' : marginPct < 5 ? 'warning' : 'ok'
}

export interface VoucherInput {
  shop_id?:          number | null
  voucher_type:      1 | 2            // 1=loja toda, 2=produtos
  reward_type:       1 | 2            // 1=R$ fixo, 2=percentual
  discount_amount?:  number           // reward_type 1
  percentage?:       number           // reward_type 2 (1-99)
  max_price?:        number           // teto R$ do desconto percentual
  min_basket_price:  number
  item_ids?:         number[]         // voucher_type 2
}

export interface FlashItemInput {
  item_id:         number
  discount_pct:    number
  stock?:          number             // qtd reservada pra promo (default: estoque disponível)
  purchase_limit?: number             // limite por comprador (0 = sem limite)
}

export interface PromoItemPreview {
  item_id:              number
  title:                string | null
  price:                number | null
  projected_margin_pct: number
  verdict:              PromoVerdict
}

export interface PromoPreview {
  verdict:       PromoVerdict
  message:       string
  floor_pct:     number
  total_items:   number
  blocked_count: number
  warning_count: number
  items:         PromoItemPreview[]
}

export interface FlashItemDetail {
  item_id:          number
  title:            string | null
  discount_pct:     number
  purchase_limit?:  number
  worst_margin_pct: number
  models: Array<{
    model_id:        number
    original_price:  number
    promotion_price: number
    margin_pct:      number
    available_stock: number
    promo_stock:     number
  }>
}
