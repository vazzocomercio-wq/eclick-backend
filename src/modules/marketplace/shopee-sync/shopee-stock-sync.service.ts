import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { MarketplaceService } from '../marketplace.service'
import { MpConnection } from '../adapters/base'
import { ShopeeAdapter } from '../adapters/shopee.adapter'
import { ShopeeProductSyncService } from './shopee-product-sync.service'

/** F18 Fase C — Propagação de ESTOQUE do ledger unificado → anúncio Shopee.
 *
 *  O Estoque Unificado (`product_stock` platform=null) é a fonte da verdade:
 *  disponível = físico + virtual − reservado − segurança (StockService.
 *  calculateAvailable), espelhado em `products.stock`. Aqui empurramos esse
 *  MESMO disponível pros anúncios Shopee vinculados (product_listings
 *  platform='shopee'), igual o ML/TikTok fazem — respeitando a regra de
 *  estoque virtual (o virtual já está embutido no disponível; a majoração por
 *  canal `virtual_markup` chega via qtyOverride do recalcAndPropagate quando
 *  existe distribuição 'shopee').
 *
 *  Dois modos:
 *   - pushStockForProduct(): AUTO, chamado pelo StockService.recalcAndPropagate
 *     em toda venda/reserva/ajuste. GATEADO por SHOPEE_STOCK_SYNC=on (OFF por
 *     padrão — não toca a loja real até o user optar). Igual TikTok.
 *   - pushStockForOrg()/pushStockForItem(): MANUAL (ação explícita do user na
 *     tela), IGNORA o gate. Pra propagação em lote e edição inline (Fase D).
 *
 *  Toda escrita loga em stock_sync_logs (channel='shopee') p/ observabilidade,
 *  igual o ML. ⚠️ Escreve estoque REAL via /api/v2/product/update_stock. */
@Injectable()
export class ShopeeStockSyncService {
  private readonly logger = new Logger(ShopeeStockSyncService.name)

  constructor(
    private readonly mp:          MarketplaceService,
    private readonly productSync: ShopeeProductSyncService,
  ) {}

  /** Gate do push AUTOMÁTICO (firehose do recalcAndPropagate). Default OFF.
   *  Não afeta os pushes MANUAIS (lote/item), que são ação explícita do user. */
  isStockSyncEnabled(): boolean {
    return process.env.SHOPEE_STOCK_SYNC === 'on'
  }

  /** Resolve conn Shopee da org + garante token fresco. Null se não conectada. */
  private async resolveConn(orgId: string): Promise<{ conn: MpConnection; adapter: ShopeeAdapter } | null> {
    const resolved = await this.mp.resolve(orgId, 'shopee')
    if (!resolved?.conn?.shop_id) return null
    const conn = await this.productSync.ensureFreshToken(resolved.conn)
    return { conn, adapter: resolved.adapter as ShopeeAdapter }
  }

  /** Anúncios Shopee vinculados a um produto (item_id + variation_id). */
  private async listingsForProduct(productId: string, shopId: number): Promise<Array<{ listing_id: string; variation_id: string | null }>> {
    const { data } = await supabaseAdmin
      .from('product_listings')
      .select('listing_id, variation_id')
      .eq('product_id', productId)
      .eq('platform', 'shopee')
      .eq('account_id', String(shopId))
      .eq('is_active', true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((data ?? []) as any[]).map(r => ({ listing_id: String(r.listing_id), variation_id: r.variation_id ?? null }))
  }

  /** Empurra `qty` pros anúncios dados, logando cada push em stock_sync_logs.
   *  Resolve o location_id do seller_stock UMA vez por item (armazém nomeado,
   *  ex "BRZ" — uniforme por loja; o update_stock precisa do mesmo). */
  private async pushToListings(
    conn:        MpConnection,
    adapter:     ShopeeAdapter,
    productId:   string,
    listings:    Array<{ listing_id: string; variation_id: string | null }>,
    qty:         number,
    triggeredBy: string,
  ): Promise<{ pushed: number; failed: number }> {
    let pushed = 0
    let failed = 0
    const locationByItem = new Map<string, string | null>()
    for (const l of listings) {
      // resolve (e cacheia) o location_id do item antes de escrever
      if (!locationByItem.has(l.listing_id)) {
        let loc: string | null = null
        try {
          loc = await adapter.resolveSellerLocationId(conn, Number(l.listing_id))
        } catch (e: unknown) {
          this.logger.warn(`[shopee.stock] resolveLocation item=${l.listing_id} falhou: ${(e as Error)?.message}`)
        }
        locationByItem.set(l.listing_id, loc)
      }
      const locationId = locationByItem.get(l.listing_id) ?? null

      const startTime = Date.now()
      let status = 'success'
      let errorMsg: string | null = null
      let httpStatus = 200
      try {
        await adapter.updateStock(conn, {
          externalProductId:   l.listing_id,
          externalVariationId: l.variation_id || null,
          quantity:            qty,
          locationId,
        })
        pushed++
      } catch (e: unknown) {
        failed++
        status = 'error'
        errorMsg = (e as Error)?.message ?? 'erro desconhecido'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        httpStatus = (e as any)?.response?.status ?? 500
        this.logger.warn(`[shopee.stock] item=${l.listing_id} model=${l.variation_id ?? ''} falhou: ${errorMsg}`)
      }
      await supabaseAdmin.from('stock_sync_logs').insert({
        product_id:    productId,
        channel:       'shopee',
        listing_id:    l.listing_id,
        sent_quantity: qty,
        confirmed_quantity: status === 'success' ? qty : null,
        status,
        error_message: errorMsg,
        http_status:   httpStatus,
        triggered_by:  triggeredBy,
        duration_ms:   Date.now() - startTime,
      })
    }
    return { pushed, failed }
  }

  /** AUTO — chamado pelo StockService.recalcAndPropagate. GATEADO.
   *  qtyOverride = disponível já calculado (ou qty da distribuição c/ markup);
   *  shouldPause força estoque 0 (out-of-stock = pausa de fato na Shopee). */
  async pushStockForProduct(
    productId:   string,
    qtyOverride?: number,
    shouldPause = false,
  ): Promise<{ pushed: number; failed?: number; skipped?: string }> {
    if (!this.isStockSyncEnabled()) return { pushed: 0, skipped: 'gate_off' }

    const { data: prod } = await supabaseAdmin
      .from('products')
      .select('organization_id, stock')
      .eq('id', productId)
      .maybeSingle<{ organization_id: string | null; stock: number | null }>()
    const orgId = prod?.organization_id ?? null
    if (!orgId) return { pushed: 0, skipped: 'no_org' }

    const resolved = await this.resolveConn(orgId)
    if (!resolved) return { pushed: 0, skipped: 'shopee_not_connected' }
    const { conn, adapter } = resolved

    const listings = await this.listingsForProduct(productId, conn.shop_id!)
    if (!listings.length) return { pushed: 0, skipped: 'no_shopee_links' }

    const qtyBase = Math.max(0, Math.round(qtyOverride ?? prod?.stock ?? 0))
    const qty = shouldPause ? 0 : qtyBase
    const { pushed, failed } = await this.pushToListings(conn, adapter, productId, listings, qty, 'recalc_auto')
    this.logger.log(`[shopee.stock] AUTO product=${productId} qty=${qty} pause=${shouldPause} pushed=${pushed} failed=${failed}`)
    return { pushed, failed }
  }

  /** MANUAL — propaga o disponível (products.stock) de TODOS os produtos com
   *  anúncio Shopee vinculado da org. Ignora o gate (ação explícita do user). */
  async pushStockForOrg(orgId: string): Promise<{
    shop_id: number; products: number; listings: number; pushed: number; failed: number
  }> {
    const resolved = await this.resolveConn(orgId)
    if (!resolved) throw new NotFoundException('Loja Shopee não conectada nesta organização')
    const { conn, adapter } = resolved
    const shopId = conn.shop_id!

    const { data: pls, error } = await supabaseAdmin
      .from('product_listings')
      .select('product_id, listing_id, variation_id')
      .eq('platform', 'shopee')
      .eq('account_id', String(shopId))
      .eq('is_active', true)
    if (error) throw new Error(`product_listings: ${error.message}`)

    // agrupa anúncios por produto
    const byProduct = new Map<string, Array<{ listing_id: string; variation_id: string | null }>>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const pl of (pls ?? []) as any[]) {
      const pid = pl.product_id as string
      if (!pid) continue
      if (!byProduct.has(pid)) byProduct.set(pid, [])
      byProduct.get(pid)!.push({ listing_id: String(pl.listing_id), variation_id: pl.variation_id ?? null })
    }
    if (!byProduct.size) return { shop_id: shopId, products: 0, listings: 0, pushed: 0, failed: 0 }

    // disponível por produto = products.stock (espelho do calculateAvailable)
    const pidList = [...byProduct.keys()]
    const stockById = new Map<string, number>()
    for (let i = 0; i < pidList.length; i += 200) {
      const chunk = pidList.slice(i, i + 200)
      const { data: prods } = await supabaseAdmin
        .from('products')
        .select('id, stock')
        .in('id', chunk)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const p of (prods ?? []) as any[]) stockById.set(p.id, Math.max(0, Math.round(Number(p.stock) || 0)))
    }

    let totalListings = 0, pushed = 0, failed = 0
    for (const [pid, listings] of byProduct) {
      totalListings += listings.length
      const qty = stockById.get(pid) ?? 0
      const r = await this.pushToListings(conn, adapter, pid, listings, qty, 'manual_bulk')
      pushed += r.pushed
      failed += r.failed
    }
    this.logger.log(`[shopee.stock] MANUAL org=${orgId} products=${byProduct.size} listings=${totalListings} pushed=${pushed} failed=${failed}`)
    return { shop_id: shopId, products: byProduct.size, listings: totalListings, pushed, failed }
  }

  /** MANUAL — escreve estoque de 1 anúncio (todas as variações vinculadas).
   *  Usado no teste controlado da Fase C e na edição inline (Fase D). Ignora
   *  o gate. Valida que o item pertence a um produto vinculado da org. */
  async pushStockForItem(orgId: string, itemId: number, quantity: number): Promise<{
    ok: boolean; pushed: number; failed: number
  }> {
    const resolved = await this.resolveConn(orgId)
    if (!resolved) throw new NotFoundException('Loja Shopee não conectada nesta organização')
    const { conn, adapter } = resolved
    const shopId = conn.shop_id!

    const { data: pls } = await supabaseAdmin
      .from('product_listings')
      .select('product_id, listing_id, variation_id')
      .eq('platform', 'shopee')
      .eq('account_id', String(shopId))
      .eq('listing_id', String(itemId))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listings = ((pls ?? []) as any[]).map(r => ({ listing_id: String(r.listing_id), variation_id: r.variation_id ?? null }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const productId = ((pls ?? [])[0] as any)?.product_id ?? null

    // se não há vínculo, ainda escreve item-level (model 0) — útil pro teste
    const targets = listings.length ? listings : [{ listing_id: String(itemId), variation_id: null }]
    const qty = Math.max(0, Math.round(Number(quantity) || 0))
    const { pushed, failed } = await this.pushToListings(conn, adapter, productId ?? itemId.toString(), targets, qty, 'manual_item')
    return { ok: failed === 0, pushed, failed }
  }

  /** AUDITORIA read-only — dump do estoque cru de 1 item (Fase C, pré-mapeamento). */
  async inspectStock(orgId: string, itemId: number) {
    const resolved = await this.resolveConn(orgId)
    if (!resolved) throw new NotFoundException('Loja Shopee não conectada nesta organização')
    return resolved.adapter.inspectItemStock(resolved.conn, itemId)
  }
}
