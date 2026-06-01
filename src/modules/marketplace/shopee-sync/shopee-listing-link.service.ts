import {
  Injectable, Logger, NotFoundException, BadRequestException,
} from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { computeContributionMargin, round2 } from '../../../common/margin'
import { MarketplaceService } from '../marketplace.service'
import { ShopeeAdapter } from '../adapters/shopee.adapter'
import { ShopeeProductSyncService } from './shopee-product-sync.service'
import { ChannelSettingsService } from '../../channel-settings/channel-settings.service'

/** F18 Fase A — Vínculo anúncio Shopee ↔ produto do catálogo (keystone).
 *
 *  Por que existe: sem vincular o anúncio Shopee a um `products`, não há como
 *  puxar CUSTO (cost_price), calcular MARGEM, nem propagar ESTOQUE do produto.
 *  O vínculo canônico mora em `public.product_listings` (mesma tabela do ML/
 *  TikTok), chave única (platform, account_id, listing_id, variation_id,
 *  product_id). Aqui `account_id = shop_id` (escopo por loja, multi-conta-safe).
 *
 *  Auto-link: o SKU da Shopee vive na VARIAÇÃO (model_sku) — `getItemSkus`
 *  busca via get_model_list, e casamos model_sku → products.sku (org-scoped).
 *  Fallback humano: manualLink/unlink pros que não casam por SKU.
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
    unmatched_items:  Array<{ item_id: number; title: string | null }>
  }> {
    const resolved = await this.mp.resolve(orgId, 'shopee')
    if (!resolved) throw new NotFoundException('Loja Shopee não conectada nesta organização')
    let conn = resolved.conn
    conn = await this.productSync.ensureFreshToken(conn)
    if (!conn.shop_id) throw new NotFoundException('Conexão Shopee sem shop_id')
    const shopId  = conn.shop_id
    const adapter = resolved.adapter as ShopeeAdapter

    // 1) anúncios mais recentes da org (item_id + snapshot p/ display)
    const { data: rows, error } = await supabaseAdmin
      .schema('shopee')
      .from('v_latest_algo_score')
      .select('item_id, input_snapshot')
      .eq('organization_id', orgId)
    if (error) throw new Error(`v_latest_algo_score: ${error.message}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listings = (rows ?? []) as Array<{ item_id: number; input_snapshot: any }>
    const itemIds = [...new Set(listings.map(r => Number(r.item_id)).filter(Number.isFinite))]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapById = new Map<number, any>()
    for (const r of listings) snapById.set(Number(r.item_id), r.input_snapshot ?? {})

    if (!itemIds.length) {
      return {
        shop_id: shopId, items: 0, items_with_sku: 0, skus_distinct: 0,
        products_matched: 0, listings_linked: 0, items_linked: 0, unmatched_items: [],
      }
    }

    // 2) SKUs por item (nível variação) via get_model_list
    const skuMap = await adapter.getItemSkus(conn, itemIds)
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

    // 4) monta linhas de product_listings (1 por model casado)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plRows: any[] = []
    const linkedItems = new Set<number>()
    const seen = new Set<string>()
    for (const itemId of itemIds) {
      const pairs = skuMap.get(itemId) ?? []
      const snap  = snapById.get(itemId) ?? {}
      for (const { model_id, sku } of pairs) {
        const prod = prodBySku.get(sku)
        if (!prod) continue
        const variationId = String(model_id ?? '')
        const key = `${shopId}|${itemId}|${variationId}|${prod.id}`
        if (seen.has(key)) continue
        seen.add(key)
        plRows.push({
          platform:          'shopee',
          account_id:        String(shopId),
          listing_id:        String(itemId),
          variation_id:      variationId,
          product_id:        prod.id,
          listing_title:     snap.title          ?? null,
          listing_price:     snap.price          ?? null,
          listing_thumbnail: snap.main_image_url ?? null,
          is_active:         true,
        })
        linkedItems.add(itemId)
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
      unmatched_items:  unmatched.slice(0, 50),
    }
    this.logger.log(`[shopee.link] org=${orgId} ${JSON.stringify({ ...out, unmatched_items: unmatched.length })}`)
    return out
  }

  /** Status de vínculo de TODOS os anúncios (pra UI: linkado? qual produto?).
   *  Fonte da verdade = product_listings (não o breakdown). */
  async getLinkStatus(orgId: string): Promise<{
    shop_id:     number
    total:       number
    linked:      number
    unlinked:    number
    with_margin: number
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items:       any[]
  }> {
    const shopId = await this.resolveShopId(orgId)

    const { data: rows, error } = await supabaseAdmin
      .schema('shopee')
      .from('v_latest_algo_score')
      .select('item_id, algo_score, input_snapshot')
      .eq('organization_id', orgId)
    if (error) throw new Error(`v_latest_algo_score: ${error.message}`)

    const { data: pls, error: plErr } = await supabaseAdmin
      .from('product_listings')
      .select('listing_id, variation_id, product_id')
      .eq('platform', 'shopee')
      .eq('account_id', String(shopId))
    if (plErr) throw new Error(`product_listings: ${plErr.message}`)

    const linkByItem = new Map<string, string>()
    const productIds = new Set<string>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const pl of (pls ?? []) as any[]) {
      if (!linkByItem.has(String(pl.listing_id))) linkByItem.set(String(pl.listing_id), pl.product_id)
      if (pl.product_id) productIds.add(pl.product_id)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prodById = new Map<string, any>()
    const pidList = [...productIds]
    for (let i = 0; i < pidList.length; i += 200) {
      const chunk = pidList.slice(i, i + 200)
      const { data: prods, error: pErr } = await supabaseAdmin
        .from('products')
        .select('id, sku, name, cost_price, price, stock, tax_percentage, tax_on_freight')
        .in('id', chunk)
      if (pErr) throw new Error(`products: ${pErr.message}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const p of (prods ?? []) as any[]) prodById.set(p.id, p)
    }

    // F18 Fase B — comissão Shopee da org (igual ao sync de pedidos) p/ margem.
    const commissionPct = await this.channelSettings.getCommissionPct(orgId, 'shopee', 0)

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
        const saleFee = round2(price * commissionPct / 100)
        const m = computeContributionMargin({
          price, saleFee, shipping: 0,
          cost:          Number(prod.cost_price),
          taxPercentage: prod.tax_percentage ?? 0,
          taxOnFreight:  prod.tax_on_freight ?? false,
        })
        margin = {
          price,
          commission_pct:          commissionPct,
          sale_fee:                saleFee,
          cost:                    round2(Number(prod.cost_price)),
          tax_amount:              m.taxAmount,
          contribution_margin:     m.contributionMargin,
          contribution_margin_pct: m.contributionMarginPct,
        }
      }

      return {
        item_id:    Number(r.item_id),
        title:      snap.title          ?? null,
        thumbnail:  snap.main_image_url ?? null,
        price,
        algo_score: r.algo_score        ?? null,
        linked:     !!prod,
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
      shop_id: shopId, total: items.length, linked,
      unlinked: items.length - linked, with_margin: withMargin, items,
    }
  }

  /** Vínculo manual item → produto (substitui qualquer vínculo anterior do item).
   *  Item-level (variation_id=''). Valida que o produto é da org. */
  async manualLink(orgId: string, itemId: number, productId: string): Promise<{ ok: true }> {
    const shopId = await this.resolveShopId(orgId)

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
    const shopId = await this.resolveShopId(orgId)
    const { data, error } = await supabaseAdmin
      .from('product_listings')
      .delete()
      .eq('platform', 'shopee')
      .eq('account_id', String(shopId))
      .eq('listing_id', String(itemId))
      .select('id')
    if (error) throw new Error(`product_listings delete: ${error.message}`)
    return { ok: true, removed: (data ?? []).length }
  }
}
