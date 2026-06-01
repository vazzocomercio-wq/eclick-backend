import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { MarketplaceService } from '../marketplace.service'
import { MpConnection } from '../adapters/base'
import { ShopeeAdapter } from '../adapters/shopee.adapter'
import { ShopeeProductSyncService } from './shopee-product-sync.service'

/** F18 Fase C — Propagação de ESTOQUE do ledger unificado → anúncio Shopee.
 *
 *  REGRA DE ESTOQUE (decisão Vazzo): a Shopee reflete o ESTOQUE VIRTUAL =
 *  **físico + virtual_quantity** (NÃO o disponível). Ou seja, NÃO descontamos
 *  segurança nem reservado — a plataforma mostra real + virtual. A fonte é
 *  `product_stock` (platform=null): quantity (físico) + virtual_quantity.
 *  Pausa (estoque 0) só quando físico+virtual = 0. Sem registro de estoque →
 *  pula (não zera o anúncio).
 *
 *  Dois modos:
 *   - pushStockForProduct(): AUTO, chamado pelo StockService.recalcAndPropagate
 *     em toda venda/reserva/ajuste. GATEADO por SHOPEE_STOCK_SYNC=on (OFF por
 *     padrão — não toca a loja real até o user optar).
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

  /** Estoque VIRTUAL a refletir na Shopee = físico + virtual_quantity (ledger
   *  product_stock platform=null). Null se não há registro de estoque (→ pula,
   *  não zera o anúncio). NÃO desconta segurança/reservado (regra Vazzo). */
  private async virtualStockFor(productId: string): Promise<number | null> {
    const { data } = await supabaseAdmin
      .from('product_stock')
      .select('quantity, virtual_quantity')
      .eq('product_id', productId)
      .is('platform', null)
      .maybeSingle<{ quantity: number | null; virtual_quantity: number | null }>()
    if (!data) return null
    return Math.max(0, Math.round(Number(data.quantity || 0) + Number(data.virtual_quantity || 0)))
  }

  /** Versão em lote do virtualStockFor (mapa product_id → físico+virtual). */
  private async virtualStockForMany(productIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    for (let i = 0; i < productIds.length; i += 200) {
      const chunk = productIds.slice(i, i + 200)
      const { data } = await supabaseAdmin
        .from('product_stock')
        .select('product_id, quantity, virtual_quantity')
        .in('product_id', chunk)
        .is('platform', null)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const r of (data ?? []) as any[]) {
        out.set(r.product_id, Math.max(0, Math.round(Number(r.quantity || 0) + Number(r.virtual_quantity || 0))))
      }
    }
    return out
  }

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

  /** AUTO — chamado pelo StockService.recalcAndPropagate em toda venda/ajuste.
   *  GATEADO (SHOPEE_STOCK_SYNC). Empurra o estoque VIRTUAL (físico+virtual);
   *  pausa (0) quando físico+virtual=0. Sem registro de estoque → pula. */
  async pushStockForProduct(
    productId: string,
  ): Promise<{ pushed: number; failed?: number; skipped?: string }> {
    if (!this.isStockSyncEnabled()) return { pushed: 0, skipped: 'gate_off' }

    const { data: prod } = await supabaseAdmin
      .from('products')
      .select('organization_id')
      .eq('id', productId)
      .maybeSingle<{ organization_id: string | null }>()
    const orgId = prod?.organization_id ?? null
    if (!orgId) return { pushed: 0, skipped: 'no_org' }

    const resolved = await this.resolveConn(orgId)
    if (!resolved) return { pushed: 0, skipped: 'shopee_not_connected' }
    const { conn, adapter } = resolved

    const listings = await this.listingsForProduct(productId, conn.shop_id!)
    if (!listings.length) return { pushed: 0, skipped: 'no_shopee_links' }

    const v = await this.virtualStockFor(productId)
    if (v == null) return { pushed: 0, skipped: 'no_stock_record' }

    const { pushed, failed } = await this.pushToListings(conn, adapter, productId, listings, v, 'recalc_auto')
    this.logger.log(`[shopee.stock] AUTO product=${productId} virtual_stock=${v} pushed=${pushed} failed=${failed}`)
    return { pushed, failed }
  }

  /** MANUAL — propaga o estoque VIRTUAL (físico+virtual) de TODOS os produtos
   *  com anúncio Shopee vinculado da org. Ignora o gate (ação explícita do
   *  user). Produto sem registro de estoque é PULADO (não zera o anúncio). */
  async pushStockForOrg(orgId: string): Promise<{
    shop_id: number; products: number; listings: number; pushed: number; failed: number; skipped_no_stock: number
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
    if (!byProduct.size) return { shop_id: shopId, products: 0, listings: 0, pushed: 0, failed: 0, skipped_no_stock: 0 }

    // estoque virtual (físico+virtual) por produto, em lote
    const stockById = await this.virtualStockForMany([...byProduct.keys()])

    let totalListings = 0, pushed = 0, failed = 0, skippedNoStock = 0
    for (const [pid, listings] of byProduct) {
      const qty = stockById.get(pid)
      if (qty == null) { skippedNoStock += listings.length; continue } // sem registro → não zera
      totalListings += listings.length
      const r = await this.pushToListings(conn, adapter, pid, listings, qty, 'manual_bulk')
      pushed += r.pushed
      failed += r.failed
    }
    this.logger.log(`[shopee.stock] MANUAL org=${orgId} products=${byProduct.size} listings=${totalListings} pushed=${pushed} failed=${failed} skipped_no_stock=${skippedNoStock}`)
    return { shop_id: shopId, products: byProduct.size, listings: totalListings, pushed, failed, skipped_no_stock: skippedNoStock }
  }

  /** MANUAL — escreve estoque de 1 anúncio. Ignora o gate (edição inline Fase D
   *  / teste controlado Fase C). Se `variationId` for dado, escreve SÓ aquele
   *  model (cirúrgico); senão, aplica `quantity` a todas as variações do item.
   *  Sem vínculo no DB, escreve item-level (model 0) — útil pro teste. */
  async pushStockForItem(orgId: string, itemId: number, quantity: number, variationId?: string | null): Promise<{
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
    let listings = ((pls ?? []) as any[]).map(r => ({ listing_id: String(r.listing_id), variation_id: r.variation_id ?? null }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const productId = ((pls ?? [])[0] as any)?.product_id ?? null

    // escopo cirúrgico: só a variação pedida
    if (variationId != null) {
      listings = listings.filter(l => String(l.variation_id ?? '') === String(variationId))
      if (!listings.length) listings = [{ listing_id: String(itemId), variation_id: String(variationId) }]
    }
    // se não há vínculo, ainda escreve item-level (model 0) — útil pro teste
    const targets = listings.length ? listings : [{ listing_id: String(itemId), variation_id: null }]
    const qty = Math.max(0, Math.round(Number(quantity) || 0))
    const { pushed, failed } = await this.pushToListings(conn, adapter, productId ?? itemId.toString(), targets, qty, 'manual_item')
    return { ok: failed === 0, pushed, failed }
  }

  /** F18 Fase D — MANUAL — escreve o PREÇO (original_price) de 1 anúncio.
   *  Edição inline (ação explícita do user, $ real). Se `variationId` dado,
   *  escreve só aquele model; senão, aplica a todas as variações do item.
   *  ⚠️ ESCREVE PREÇO REAL. Loga em stock_sync_logs (channel='shopee_price'). */
  async pushPriceForItem(orgId: string, itemId: number, price: number, variationId?: string | null): Promise<{
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
    let listings = ((pls ?? []) as any[]).map(r => ({ listing_id: String(r.listing_id), variation_id: r.variation_id ?? null }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const productId = ((pls ?? [])[0] as any)?.product_id ?? null

    if (variationId != null) {
      listings = listings.filter(l => String(l.variation_id ?? '') === String(variationId))
      if (!listings.length) listings = [{ listing_id: String(itemId), variation_id: String(variationId) }]
    }
    const targets = listings.length ? listings : [{ listing_id: String(itemId), variation_id: null }]
    const p = Number(price)

    let pushed = 0, failed = 0
    for (const l of targets) {
      const startTime = Date.now()
      let status = 'success'
      let errorMsg: string | null = null
      let httpStatus = 200
      try {
        await adapter.updatePrice(conn, {
          externalProductId:   l.listing_id,
          externalVariationId: l.variation_id || null,
          price:               p,
        })
        pushed++
      } catch (e: unknown) {
        failed++
        status = 'error'
        errorMsg = (e as Error)?.message ?? 'erro desconhecido'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        httpStatus = (e as any)?.response?.status ?? 500
        this.logger.warn(`[shopee.price] item=${l.listing_id} model=${l.variation_id ?? ''} falhou: ${errorMsg}`)
      }
      await supabaseAdmin.from('stock_sync_logs').insert({
        product_id:    productId ?? itemId.toString(),
        channel:       'shopee_price',
        listing_id:    l.listing_id,
        sent_quantity: Math.round(p), // reusa coluna p/ registrar o valor enviado
        status,
        error_message: errorMsg,
        http_status:   httpStatus,
        triggered_by:  'manual_price',
        duration_ms:   Date.now() - startTime,
      })
    }
    return { ok: failed === 0, pushed, failed }
  }

  /** AUDITORIA read-only — dump do estoque cru de 1 item (Fase C, pré-mapeamento). */
  async inspectStock(orgId: string, itemId: number) {
    const resolved = await this.resolveConn(orgId)
    if (!resolved) throw new NotFoundException('Loja Shopee não conectada nesta organização')
    return resolved.adapter.inspectItemStock(resolved.conn, itemId)
  }
}
