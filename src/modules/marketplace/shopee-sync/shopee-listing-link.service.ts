import {
  Injectable, Logger, NotFoundException, BadRequestException,
} from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { computeContributionMargin, round2 } from '../../../common/margin'
import { MarketplaceService } from '../marketplace.service'
import { MpConnection } from '../adapters/base'
import { ShopeeAdapter } from '../adapters/shopee.adapter'
import { ShopeeProductSyncService } from './shopee-product-sync.service'
import { ChannelSettingsService, estimateSaleFee } from '../../channel-settings/channel-settings.service'

/** F18 Fase A — Vínculo anúncio Shopee ↔ produto do catálogo (keystone).
 *
 *  Por que existe: sem vincular o anúncio Shopee a um `products`, não há como
 *  puxar CUSTO (cost_price), calcular MARGEM, nem propagar ESTOQUE do produto.
 *  O vínculo canônico mora em `public.product_listings` (mesma tabela do ML/
 *  TikTok), chave única (platform, account_id, listing_id, variation_id,
 *  product_id). Aqui `account_id = shop_id` (escopo por loja, multi-conta-safe).
 *
 *  Auto-link: o SKU da Shopee vive na VARIAÇÃO (model_sku) — `getItemSkus`
 *  busca via get_model_list, e casamos em 2 níveis (org-scoped):
 *   1. model_sku → products.sku            (vínculo nível-PRODUTO)
 *   2. model_sku → products.variations[].sku (vínculo nível-VARIAÇÃO — o SKU da
 *      variação do catálogo, ex VZ-10010501-54=Creme, gravado em
 *      product_listings.product_variation_sku; product_id = produto pai)
 *  Fallback humano: manualLink/unlink (item inteiro) e linkModels (por variação).
 *
 *  NÃO mexe em `algo_score_breakdown.product_id` (é INSERT-only, sobrescrito no
 *  próximo sync) — a fonte da verdade do vínculo é SEMPRE product_listings, e
 *  getLinkStatus lê dali (robusto a re-sync). */
@Injectable()
export class ShopeeListingLinkService {
  private readonly logger = new Logger(ShopeeListingLinkService.name)

  constructor(
    private readonly mp:              MarketplaceService,
    private readonly productSync:     ShopeeProductSyncService,
    private readonly channelSettings: ChannelSettingsService,
  ) {}

  /** Resolve só o shop_id da loja conectada (sem refresh — operação de leitura). */
  private async resolveShopId(orgId: string): Promise<number> {
    const resolved = await this.mp.resolve(orgId, 'shopee')
    if (!resolved?.conn?.shop_id) {
      throw new NotFoundException('Loja Shopee não conectada nesta organização')
    }
    return resolved.conn.shop_id
  }

  /** TODOS os shop_ids Shopee conectados da org (multi-conta). */
  private async resolveShopIds(orgId: string): Promise<number[]> {
    const conns = await this.mp.getConnections(orgId, 'shopee')
    const ids = conns.map(c => c.shop_id).filter((n): n is number => !!n)
    if (!ids.length) throw new NotFoundException('Loja Shopee não conectada nesta organização')
    return ids
  }

  /** Descobre a qual shop_id um item pertence (via algo score breakdown). */
  private async shopOfItem(orgId: string, itemId: number, fallbackShopIds: number[]): Promise<number> {
    const { data } = await supabaseAdmin
      .schema('shopee')
      .from('v_latest_algo_score')
      .select('shop_id')
      .eq('organization_id', orgId)
      .eq('item_id', itemId)
      .maybeSingle<{ shop_id: number }>()
    return data?.shop_id ?? fallbackShopIds[0]
  }

  /** Auto-vincula TODOS os anúncios da loja por SKU de variação → products.sku.
   *  Idempotente (upsert na chave única). Retorna métricas de cobertura. */
  async autoLinkAll(orgId: string): Promise<{
    shop_id:          number
    items:            number
    items_with_sku:   number
    skus_distinct:    number
    products_matched: number
    listings_linked:  number
    items_linked:     number
    variation_links:  number
    unmatched_items:  Array<{ item_id: number; title: string | null }>
  }> {
    const resolvedAll = await this.mp.resolveAll(orgId, 'shopee')
    if (!resolvedAll.length) throw new NotFoundException('Loja Shopee não conectada nesta organização')
    // conns por shop_id (token fresco) — multi-conta
    const connByShop = new Map<number, MpConnection>()
    for (const { conn: c0 } of resolvedAll) {
      if (!c0.shop_id) continue
      try { connByShop.set(c0.shop_id, await this.productSync.ensureFreshToken(c0)) }
      catch (e) { this.logger.warn(`[shopee.link] token shop=${c0.shop_id}: ${(e as Error)?.message}`) }
    }
    const shopId = resolvedAll[0].conn.shop_id!

    // 1) anúncios da org (item_id + snapshot + shop_id) — TODAS as lojas
    const { data: rows, error } = await supabaseAdmin
      .schema('shopee')
      .from('v_latest_algo_score')
      .select('item_id, input_snapshot, shop_id')
      .eq('organization_id', orgId)
    if (error) throw new Error(`v_latest_algo_score: ${error.message}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listings = (rows ?? []) as Array<{ item_id: number; input_snapshot: any; shop_id: number }>
    const itemIds = [...new Set(listings.map(r => Number(r.item_id)).filter(Number.isFinite))]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapById = new Map<number, any>()
    const shopByItem = new Map<number, number>()
    for (const r of listings) { snapById.set(Number(r.item_id), r.input_snapshot ?? {}); shopByItem.set(Number(r.item_id), Number(r.shop_id)) }

    if (!itemIds.length) {
      return {
        shop_id: shopId, items: 0, items_with_sku: 0, skus_distinct: 0,
        products_matched: 0, listings_linked: 0, items_linked: 0,
        variation_links: 0, unmatched_items: [],
      }
    }

    // 2) SKUs por item via get_model_list/item_sku — agrupando por loja (cada
    //    loja usa o SEU conn; item de uma loja não existe no token de outra).
    const skuMap = new Map<number, Array<{ model_id: number; sku: string }>>()
    const itemsByShop = new Map<number, number[]>()
    for (const id of itemIds) {
      const sid = shopByItem.get(id) ?? shopId
      if (!itemsByShop.has(sid)) itemsByShop.set(sid, [])
      itemsByShop.get(sid)!.push(id)
    }
    for (const [sid, ids] of itemsByShop) {
      const c = connByShop.get(sid)
      if (!c) { this.logger.warn(`[shopee.link] shop=${sid} sem conn — ${ids.length} itens pulados`); continue }
      const adapter = resolvedAll[0].adapter as ShopeeAdapter
      const partial = await adapter.getItemSkus(c, ids)
      for (const [k, v] of partial) skuMap.set(k, v)
    }
    let itemsWithSku = 0
    const allSkus = new Set<string>()
    for (const pairs of skuMap.values()) {
      if (pairs.length) itemsWithSku++
      for (const p of pairs) allSkus.add(p.sku)
    }

    // 3) casa SKU → produto (org-scoped), em chunks
    const skuList = [...allSkus]
    const prodBySku = new Map<string, { id: string }>()
    for (let i = 0; i < skuList.length; i += 200) {
      const chunk = skuList.slice(i, i + 200)
      const { data: prods, error: pErr } = await supabaseAdmin
        .from('products')
        .select('id, sku')
        .eq('organization_id', orgId)
        .in('sku', chunk)
      if (pErr) throw new Error(`products: ${pErr.message}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const p of (prods ?? []) as any[]) {
        if (p.sku) prodBySku.set(String(p.sku), { id: p.id })
      }
    }

    // 3b) casa SKU → VARIAÇÃO do catálogo (products.variations JSONB). O SKU da
    //     variação (VZ-XXXX-54 etc) não vive em products.sku — vive dentro do
    //     array. Índice completo da org (paginado) porque JSONB não filtra por
    //     .in() no PostgREST.
    const varBySku = await this.catalogVariationIndex(orgId)

    // 4) monta linhas de product_listings (1 por model casado). Prioridade:
    //    products.sku (nível-produto) > variação do catálogo (nível-variação).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plRows: any[] = []
    const linkedItems = new Set<number>()
    const seen = new Set<string>()
    let variationLinks = 0
    for (const itemId of itemIds) {
      const pairs = skuMap.get(itemId) ?? []
      const snap  = snapById.get(itemId) ?? {}
      const itemShop = shopByItem.get(itemId) ?? shopId   // loja DONA do item
      for (const { model_id, sku } of pairs) {
        const prod   = prodBySku.get(sku)
        const catVar = prod ? null : varBySku.get(sku)
        const productId = prod?.id ?? catVar?.productId
        if (!productId) continue
        const variationId = String(model_id ?? '')
        const key = `${itemShop}|${itemId}|${variationId}|${productId}`
        if (seen.has(key)) continue
        seen.add(key)
        plRows.push({
          platform:              'shopee',
          account_id:            String(itemShop),
          listing_id:            String(itemId),
          variation_id:          variationId,
          product_id:            productId,
          product_variation_sku: catVar ? sku : null,
          listing_title:         snap.title          ?? null,
          listing_price:         snap.price          ?? null,
          listing_thumbnail:     snap.main_image_url ?? null,
          is_active:             true,
        })
        linkedItems.add(itemId)
        if (catVar) variationLinks++
      }
    }

    // 5) upsert idempotente
    let linked = 0
    for (let i = 0; i < plRows.length; i += 500) {
      const chunk = plRows.slice(i, i + 500)
      const { error: upErr } = await supabaseAdmin
        .from('product_listings')
        .upsert(chunk, { onConflict: 'platform,account_id,listing_id,variation_id,product_id' })
      if (upErr) throw new Error(`product_listings upsert: ${upErr.message}`)
      linked += chunk.length
    }

    const unmatched = itemIds
      .filter(id => !linkedItems.has(id))
      .map(id => ({ item_id: id, title: (snapById.get(id)?.title ?? null) as string | null }))

    const out = {
      shop_id:          shopId,
      items:            itemIds.length,
      items_with_sku:   itemsWithSku,
      skus_distinct:    allSkus.size,
      products_matched: prodBySku.size,
      listings_linked:  linked,
      items_linked:     linkedItems.size,
      variation_links:  variationLinks,
      unmatched_items:  unmatched.slice(0, 50),
    }
    this.logger.log(`[shopee.link] org=${orgId} ${JSON.stringify({ ...out, unmatched_items: unmatched.length })}`)
    return out
  }

  /** Status de vínculo de TODOS os anúncios (pra UI: linkado? qual produto?).
   *  Fonte da verdade = product_listings (não o breakdown). */
  async getLinkStatus(orgId: string): Promise<{
    shop_id:     number
    shop_ids:    number[]
    total:       number
    linked:      number
    unlinked:    number
    with_margin: number
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items:       any[]
  }> {
    const shopIds = await this.resolveShopIds(orgId)  // TODAS as contas

    const { data: rows, error } = await supabaseAdmin
      .schema('shopee')
      .from('v_latest_algo_score')
      .select('item_id, algo_score, input_snapshot, shop_id')
      .eq('organization_id', orgId)
    if (error) throw new Error(`v_latest_algo_score: ${error.message}`)

    const { data: pls, error: plErr } = await supabaseAdmin
      .from('product_listings')
      .select('listing_id, variation_id, product_id, product_variation_sku')
      .eq('platform', 'shopee')
      .in('account_id', shopIds.map(String))   // anúncios de TODAS as lojas
    if (plErr) throw new Error(`product_listings: ${plErr.message}`)

    const linkByItem = new Map<string, string>()
    const productIds = new Set<string>()
    // vínculos nível-VARIAÇÃO por item (variation_id = model_id Shopee)
    const varLinksByItem = new Map<string, Array<{ variation_id: string; product_variation_sku: string | null }>>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const pl of (pls ?? []) as any[]) {
      if (!linkByItem.has(String(pl.listing_id))) linkByItem.set(String(pl.listing_id), pl.product_id)
      if (pl.product_id) productIds.add(pl.product_id)
      if (pl.variation_id) {
        const arr = varLinksByItem.get(String(pl.listing_id)) ?? []
        arr.push({ variation_id: String(pl.variation_id), product_variation_sku: pl.product_variation_sku ?? null })
        varLinksByItem.set(String(pl.listing_id), arr)
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prodById = new Map<string, any>()
    const pidList = [...productIds]
    for (let i = 0; i < pidList.length; i += 200) {
      const chunk = pidList.slice(i, i + 200)
      const { data: prods, error: pErr } = await supabaseAdmin
        .from('products')
        .select('id, sku, name, cost_price, price, stock, tax_percentage, tax_on_freight, category')
        .in('id', chunk)
      if (pErr) throw new Error(`products: ${pErr.message}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const p of (prods ?? []) as any[]) prodById.set(p.id, p)
    }

    // F18 Fase B — take rate Shopee da org p/ margem. Lê o achatado (fallback) +
    // as regras por FAIXA DE TICKET (channel_fee_rules) uma vez; cada anúncio
    // resolve por faixa via pickRuleTakeRate (preço do item), caindo no achatado.
    const flatTakePct = await this.channelSettings.getEstimatedTakeRatePct(orgId, 'shopee', 0)
    const feeRules    = await this.channelSettings.getFeeRules(orgId, 'shopee')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = ((rows ?? []) as any[]).map(r => {
      const pid  = linkByItem.get(String(r.item_id)) ?? null
      const prod = pid ? prodById.get(pid) : null
      const snap = r.input_snapshot ?? {}
      // preço do anúncio Shopee (snapshot); fallback p/ preço do produto.
      const price = snap.price != null ? Number(snap.price)
        : (prod?.price != null ? Number(prod.price) : null)

      // F18 Fase B — margem de contribuição ESTIMADA do anúncio (motor canônico
      // margin.ts, mesmo dos pedidos). shipping=0: frete Shopee varia por pedido
      // (comprador costuma pagar) — é estimativa "se vender a esse preço".
      let margin: {
        price: number; commission_pct: number; sale_fee: number; cost: number
        tax_amount: number; contribution_margin: number; contribution_margin_pct: number
      } | null = null
      if (prod && prod.cost_price != null && price != null && price > 0) {
        // Tarifa Shopee = % + FIXA por unidade (tabela mar/2026), regra por
        // faixa/categoria; cai no % achatado se não houver regra. O
        // commission_pct devolvido é o take EFETIVO (fee/preço) — a UI
        // recalcula a tarifa a partir dele e fecha no mesmo valor.
        const saleFee = estimateSaleFee(feeRules, price, 1, flatTakePct, prod.category ?? null)
        const itemTakePct = round2(saleFee / price * 100)
        const m = computeContributionMargin({
          price, saleFee, shipping: 0,
          cost:          Number(prod.cost_price),
          taxPercentage: prod.tax_percentage ?? 0,
          taxOnFreight:  prod.tax_on_freight ?? false,
        })
        margin = {
          price,
          commission_pct:          itemTakePct,
          sale_fee:                saleFee,
          cost:                    round2(Number(prod.cost_price)),
          tax_amount:              m.taxAmount,
          contribution_margin:     m.contributionMargin,
          contribution_margin_pct: m.contributionMarginPct,
        }
      }

      const varLinks = varLinksByItem.get(String(r.item_id)) ?? []
      return {
        item_id:    Number(r.item_id),
        shop_id:    r.shop_id != null ? Number(r.shop_id) : null,
        title:      snap.title          ?? null,
        thumbnail:  snap.main_image_url ?? null,
        price,
        algo_score: r.algo_score        ?? null,
        linked:     !!prod,
        // vínculos por variação (model ↔ variação do catálogo por SKU)
        variation_links:      varLinks.length,
        variation_skus:       varLinks.map(v => v.product_variation_sku).filter(Boolean),
        product:    prod ? {
          id:             prod.id,
          sku:            prod.sku,
          name:           prod.name,
          cost_price:     prod.cost_price,
          price:          prod.price,
          stock:          prod.stock,
          tax_percentage: prod.tax_percentage ?? null,
          tax_on_freight: prod.tax_on_freight ?? false,
        } : null,
        margin,
      }
    })
    const linked = items.filter(i => i.linked).length
    const withMargin = items.filter(i => i.margin != null).length
    return {
      shop_id: shopIds[0], shop_ids: shopIds, total: items.length, linked,
      unlinked: items.length - linked, with_margin: withMargin, items,
    }
  }

  /** Vínculo manual item → produto (substitui qualquer vínculo anterior do item).
   *  Item-level (variation_id=''). Valida que o produto é da org. */
  async manualLink(orgId: string, itemId: number, productId: string): Promise<{ ok: true }> {
    const shopIds = await this.resolveShopIds(orgId)
    const shopId = await this.shopOfItem(orgId, itemId, shopIds)  // loja DONA do item

    const { data: prod, error: pErr } = await supabaseAdmin
      .from('products')
      .select('id')
      .eq('id', productId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (pErr) throw new Error(`products: ${pErr.message}`)
    if (!prod) throw new BadRequestException('Produto não encontrado nesta organização')

    const { data: snapRow } = await supabaseAdmin
      .schema('shopee')
      .from('v_latest_algo_score')
      .select('input_snapshot')
      .eq('organization_id', orgId)
      .eq('item_id', itemId)
      .maybeSingle()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snap = (snapRow?.input_snapshot ?? {}) as any

    // relink = substituição: remove vínculos antigos do item antes de inserir
    await supabaseAdmin
      .from('product_listings')
      .delete()
      .eq('platform', 'shopee')
      .eq('account_id', String(shopId))
      .eq('listing_id', String(itemId))

    const { error: upErr } = await supabaseAdmin
      .from('product_listings')
      .upsert({
        platform:          'shopee',
        account_id:        String(shopId),
        listing_id:        String(itemId),
        variation_id:      '',
        product_id:        prod.id,
        listing_title:     snap.title          ?? null,
        listing_price:     snap.price          ?? null,
        listing_thumbnail: snap.main_image_url ?? null,
        is_active:         true,
      }, { onConflict: 'platform,account_id,listing_id,variation_id,product_id' })
    if (upErr) throw new Error(`product_listings upsert: ${upErr.message}`)

    return { ok: true }
  }

  /** Remove o vínculo de um item (todas as variações). Escopo por loja. */
  async unlink(orgId: string, itemId: number): Promise<{ ok: true; removed: number }> {
    const shopIds = await this.resolveShopIds(orgId)
    // remove o vínculo do item em QUALQUER loja da org (escopo multi-conta)
    const { data, error } = await supabaseAdmin
      .from('product_listings')
      .delete()
      .eq('platform', 'shopee')
      .in('account_id', shopIds.map(String))
      .eq('listing_id', String(itemId))
      .select('id')
    if (error) throw new Error(`product_listings delete: ${error.message}`)
    return { ok: true, removed: (data ?? []).length }
  }

  // ── Vínculo por VARIAÇÃO (model Shopee ↔ variação do catálogo) ────────────

  /** Índice SKU-de-variação → produto pai, varrendo products.variations (JSONB)
   *  da org. Primeiro SKU vence em caso de duplicata (loga warn). */
  private async catalogVariationIndex(orgId: string): Promise<Map<string, {
    productId: string; productName: string | null; productSku: string | null
    sku: string; value: string | null; type: string | null
  }>> {
    const out = new Map<string, {
      productId: string; productName: string | null; productSku: string | null
      sku: string; value: string | null; type: string | null
    }>()
    const PAGE = 1000
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabaseAdmin
        .from('products')
        .select('id, name, sku, variations')
        .eq('organization_id', orgId)
        .not('variations', 'is', null)
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`products.variations: ${error.message}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const batch = (data ?? []) as any[]
      for (const p of batch) {
        const vars = Array.isArray(p.variations) ? p.variations : []
        for (const v of vars) {
          const sku = (v?.sku ?? '').toString().trim()
          if (!sku) continue
          if (out.has(sku)) {
            this.logger.warn(`[shopee.link] SKU de variação duplicado na org: ${sku} (produtos ${out.get(sku)!.productId} e ${p.id})`)
            continue
          }
          out.set(sku, {
            productId:   p.id,
            productName: p.name ?? null,
            productSku:  p.sku  ?? null,
            sku,
            value: (v?.value ?? null) as string | null,
            type:  (v?.type  ?? null) as string | null,
          })
        }
      }
      if (batch.length < PAGE) break
    }
    return out
  }

  /** Conn (token fresco) da loja DONA de um item — via product_listings, senão
   *  v_latest_algo_score, senão primeira conta da org. */
  private async connForItem(orgId: string, itemId: number): Promise<{ conn: MpConnection; adapter: ShopeeAdapter; shopId: number }> {
    const resolvedAll = await this.mp.resolveAll(orgId, 'shopee')
    if (!resolvedAll.length) throw new NotFoundException('Loja Shopee não conectada nesta organização')
    const shopIds = resolvedAll.map(r => r.conn.shop_id).filter((n): n is number => !!n)

    const { data: pl } = await supabaseAdmin
      .from('product_listings')
      .select('account_id')
      .eq('platform', 'shopee')
      .eq('listing_id', String(itemId))
      .limit(1)
      .maybeSingle<{ account_id: string }>()
    const shopId = pl?.account_id
      ? Number(pl.account_id)
      : await this.shopOfItem(orgId, itemId, shopIds)

    const match = resolvedAll.find(r => r.conn.shop_id === shopId) ?? resolvedAll[0]
    const conn = await this.productSync.ensureFreshToken(match.conn)
    return { conn, adapter: match.adapter as ShopeeAdapter, shopId: conn.shop_id! }
  }

  /** Models (variações) de um item DIRETO da Shopee + estado de vínculo de cada
   *  um + sugestão por SKU (variação do catálogo com o mesmo SKU). Alimenta o
   *  painel "Variações" do drawer no Listing Center. */
  async getItemModels(orgId: string, itemId: number): Promise<{
    item_id: number
    shop_id: number
    models: Array<{
      model_id:  number
      model_sku: string
      name:      string
      price:     number | null
      stock:     number | null
      link: {
        product_id: string; product_name: string | null; product_sku: string | null
        product_variation_sku: string | null; variation_value: string | null
      } | null
      suggestion: {
        product_id: string; product_name: string | null; product_sku: string | null
        product_variation_sku: string; variation_value: string | null
      } | null
    }>
  }> {
    const { conn, adapter, shopId } = await this.connForItem(orgId, itemId)
    const models = await adapter.getItemModels(conn, itemId)

    // vínculos atuais do item (nível-variação e nível-item)
    const { data: pls, error: plErr } = await supabaseAdmin
      .from('product_listings')
      .select('variation_id, product_id, product_variation_sku')
      .eq('platform', 'shopee')
      .eq('account_id', String(shopId))
      .eq('listing_id', String(itemId))
    if (plErr) throw new Error(`product_listings: ${plErr.message}`)
    const linkByModel = new Map<string, { product_id: string; product_variation_sku: string | null }>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const pl of (pls ?? []) as any[]) {
      if (pl.variation_id) linkByModel.set(String(pl.variation_id), {
        product_id: pl.product_id, product_variation_sku: pl.product_variation_sku ?? null,
      })
    }

    const varIndex = await this.catalogVariationIndex(orgId)

    // nomes dos produtos vinculados (pra exibição)
    const pids = [...new Set([...linkByModel.values()].map(l => l.product_id).filter(Boolean))]
    const prodById = new Map<string, { name: string | null; sku: string | null }>()
    if (pids.length) {
      const { data: prods } = await supabaseAdmin
        .from('products')
        .select('id, name, sku')
        .in('id', pids)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const p of (prods ?? []) as any[]) prodById.set(p.id, { name: p.name ?? null, sku: p.sku ?? null })
    }

    return {
      item_id: itemId,
      shop_id: shopId,
      models: models.map(m => {
        const link = linkByModel.get(String(m.model_id)) ?? null
        const linkedVar = link?.product_variation_sku ? varIndex.get(link.product_variation_sku) : null
        const sug = !link && m.model_sku ? varIndex.get(m.model_sku) : null
        return {
          model_id:  m.model_id,
          model_sku: m.model_sku,
          name:      m.name,
          price:     m.price,
          stock:     m.stock,
          link: link ? {
            product_id:            link.product_id,
            product_name:          prodById.get(link.product_id)?.name ?? linkedVar?.productName ?? null,
            product_sku:           prodById.get(link.product_id)?.sku  ?? linkedVar?.productSku  ?? null,
            product_variation_sku: link.product_variation_sku,
            variation_value:       linkedVar?.value ?? null,
          } : null,
          suggestion: sug ? {
            product_id:            sug.productId,
            product_name:          sug.productName,
            product_sku:           sug.productSku,
            product_variation_sku: sug.sku,
            variation_value:       sug.value,
          } : null,
        }
      }),
    }
  }

  /** Vincula models de um item a produtos/variações do catálogo. Cada entrada:
   *  { model_id, product_id, product_variation_sku? }. Substitui o vínculo
   *  anterior DAQUELES models (não mexe nos demais nem no nível-item). */
  async linkModels(
    orgId:  string,
    itemId: number,
    links:  Array<{ model_id: number; product_id: string; product_variation_sku?: string | null }>,
  ): Promise<{ ok: true; linked: number }> {
    if (!Array.isArray(links) || !links.length) {
      throw new BadRequestException('links vazio — informe ao menos um model')
    }
    // só escrita no DB — resolve a loja SEM depender de token Shopee
    const shopIds = await this.resolveShopIds(orgId)
    const { data: plShop } = await supabaseAdmin
      .from('product_listings')
      .select('account_id')
      .eq('platform', 'shopee')
      .eq('listing_id', String(itemId))
      .limit(1)
      .maybeSingle<{ account_id: string }>()
    const shopId = plShop?.account_id
      ? Number(plShop.account_id)
      : await this.shopOfItem(orgId, itemId, shopIds)

    // valida produtos da org
    const pids = [...new Set(links.map(l => l.product_id).filter(Boolean))]
    const { data: prods, error: pErr } = await supabaseAdmin
      .from('products')
      .select('id, variations')
      .eq('organization_id', orgId)
      .in('id', pids)
    if (pErr) throw new Error(`products: ${pErr.message}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prodMap = new Map<string, any>(((prods ?? []) as any[]).map(p => [p.id, p]))
    for (const l of links) {
      if (!prodMap.has(l.product_id)) {
        throw new BadRequestException(`Produto ${l.product_id} não encontrado nesta organização`)
      }
      // se veio SKU de variação, confere que existe no produto (proteção contra typo)
      if (l.product_variation_sku) {
        const vars = prodMap.get(l.product_id)?.variations
        const ok = Array.isArray(vars) && vars.some(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (v: any) => (v?.sku ?? '').toString().trim() === l.product_variation_sku,
        )
        if (!ok) {
          throw new BadRequestException(
            `Variação ${l.product_variation_sku} não existe no produto — confira o SKU da variação no cadastro`)
        }
      }
    }

    // snapshot do anúncio (título/preço/foto) pro card do vínculo
    const { data: snapRow } = await supabaseAdmin
      .schema('shopee')
      .from('v_latest_algo_score')
      .select('input_snapshot')
      .eq('organization_id', orgId)
      .eq('item_id', itemId)
      .maybeSingle()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snap = (snapRow?.input_snapshot ?? {}) as any

    // substitui os vínculos DESSES models
    const modelIds = [...new Set(links.map(l => String(l.model_id)))]
    await supabaseAdmin
      .from('product_listings')
      .delete()
      .eq('platform', 'shopee')
      .eq('account_id', String(shopId))
      .eq('listing_id', String(itemId))
      .in('variation_id', modelIds)

    const rows = links.map(l => ({
      platform:              'shopee',
      account_id:            String(shopId),
      listing_id:            String(itemId),
      variation_id:          String(l.model_id),
      product_id:            l.product_id,
      product_variation_sku: l.product_variation_sku ?? null,
      listing_title:         snap.title          ?? null,
      listing_price:         snap.price          ?? null,
      listing_thumbnail:     snap.main_image_url ?? null,
      is_active:             true,
    }))
    const { error: upErr } = await supabaseAdmin
      .from('product_listings')
      .upsert(rows, { onConflict: 'platform,account_id,listing_id,variation_id,product_id' })
    if (upErr) throw new Error(`product_listings upsert: ${upErr.message}`)

    return { ok: true, linked: rows.length }
  }

  /** Remove o vínculo de UM model específico do item. */
  async unlinkModel(orgId: string, itemId: number, modelId: number): Promise<{ ok: true; removed: number }> {
    const shopIds = await this.resolveShopIds(orgId)
    const { data, error } = await supabaseAdmin
      .from('product_listings')
      .delete()
      .eq('platform', 'shopee')
      .in('account_id', shopIds.map(String))
      .eq('listing_id', String(itemId))
      .eq('variation_id', String(modelId))
      .select('id')
    if (error) throw new Error(`product_listings delete: ${error.message}`)
    return { ok: true, removed: (data ?? []).length }
  }
}
