import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { MarketplaceService } from '../marketplace.service'
import { MarketplaceAdapterRegistry } from '../adapters/registry'
import { MpConnection, RawListing } from '../adapters/base'
import { ShopeeAlgoScoreService } from '../shopee-algo-score/shopee-algo-score.service'
import { AlgoScoreInput, ShopMetricsInput } from '../shopee-algo-score/algo-score.types'
import { ShopeeQualityService } from '../shopee-quality/shopee-quality.service'

/** F18 F0.7 — Sync inicial de produtos Shopee.
 *
 *  Puxa os anúncios reais da loja (listProducts: get_item_list →
 *  get_item_base_info) e, pra cada um, computa+persiste o Algorithm Score em
 *  shopee.algo_score_breakdown — alimentando o Listing Center com dado REAL
 *  (o input_snapshot leva título/foto/SKU pro card). Sem sinais de
 *  performance/qualidade ainda (sales/ctr/shop_metrics) → score parcial
 *  honesto (pilares relevância+preço; demais neutros, sem issue falsa).
 *
 *  Refresh-on-demand: se o access_token estiver vencido/perto de vencer, renova
 *  ANTES de chamar a API (Shopee access dura 4h; refresh rotaciona os 2 tokens).
 *
 *  computeAndPersist INSERE (não upsert) → preserva histórico; o Listing Center
 *  lê v_latest_algo_score (último por item). Re-sync = novo snapshot. */
@Injectable()
export class ShopeeProductSyncService {
  private readonly logger = new Logger(ShopeeProductSyncService.name)

  /** Margem de segurança pra renovar o token antes do vencimento real. */
  private static readonly REFRESH_SKEW_MS = 5 * 60 * 1000 // 5min
  /** Trava de segurança contra loop de paginação infinito. */
  private static readonly MAX_PAGES = 200

  constructor(
    private readonly mp:       MarketplaceService,
    private readonly registry: MarketplaceAdapterRegistry,
    private readonly algo:     ShopeeAlgoScoreService,
    private readonly quality:  ShopeeQualityService,
  ) {}

  /** Sincroniza todos os anúncios NORMAL da loja Shopee conectada da org.
   *  Retorna resumo. Lança NotFound se a org não tem Shopee conectada. */
  /** Sincroniza TODAS as lojas Shopee conectadas da org (multi-conta). */
  async syncProducts(orgId: string): Promise<{
    started_at: string
    shops:      Array<{ shop_id: number; pages: number; items: number; scored: number; failed: number }>
    items:      number
    scored:     number
    failed:     number
  }> {
    const startedAt = new Date().toISOString()
    const resolvedAll = await this.mp.resolveAll(orgId, 'shopee')
    if (!resolvedAll.length) throw new NotFoundException('Loja Shopee não conectada nesta organização')

    const shops: Array<{ shop_id: number; pages: number; items: number; scored: number; failed: number }> = []
    for (const { conn: c0, adapter } of resolvedAll) {
      try {
        const conn = await this.ensureFreshToken(c0)
        if (!conn.shop_id) continue
        shops.push(await this.syncOneShop(orgId, conn, adapter))
      } catch (e: unknown) {
        this.logger.warn(`[shopee.sync] shop=${c0.shop_id} falhou: ${(e as Error)?.message}`)
      }
    }
    const tot = shops.reduce((a, s) => ({ items: a.items + s.items, scored: a.scored + s.scored, failed: a.failed + s.failed }), { items: 0, scored: 0, failed: 0 })
    this.logger.log(`[shopee.sync] org=${orgId} shops=${shops.length} ${JSON.stringify(tot)}`)
    return { started_at: startedAt, shops, ...tot }
  }

  /** Sincroniza UMA loja Shopee (paginação → Algorithm Score). */
  private async syncOneShop(orgId: string, conn: MpConnection, adapter: { listProducts: (c: MpConnection, cursor?: string | null) => Promise<{ items: RawListing[]; nextCursor: string | null }> }): Promise<{ shop_id: number; pages: number; items: number; scored: number; failed: number }> {
    const shopId = conn.shop_id!
    const shopMetrics = await this.loadShopMetrics(orgId, shopId)
    let pages = 0, items = 0, scored = 0, failed = 0
    let cursor: string | null = null
    do {
      const page = await adapter.listProducts(conn, cursor)
      pages++
      for (const listing of page.items) {
        items++
        try {
          await this.algo.computeAndPersist(this.toAlgoInput(listing, shopId, shopMetrics), orgId)
          scored++
        } catch (e: unknown) {
          failed++
          this.logger.warn(`[shopee.sync] shop=${shopId} score falhou item=${listing.external_product_id}: ${(e as Error)?.message}`)
        }
      }
      cursor = page.nextCursor
      if (pages >= ShopeeProductSyncService.MAX_PAGES) { this.logger.warn(`[shopee.sync] shop=${shopId} MAX_PAGES`); break }
    } while (cursor)
    return { shop_id: shopId, pages, items, scored, failed }
  }

  /** Renova o token se vencido/perto. Persiste os 2 tokens novos (rotação) e
   *  devolve a conn atualizada. Em falha de refresh, propaga (caller decide). */
  async ensureFreshToken(conn: MpConnection): Promise<MpConnection> {
    if (!conn.expires_at) return conn
    const expMs = new Date(conn.expires_at).getTime()
    if (!Number.isFinite(expMs)) return conn
    if (expMs - Date.now() > ShopeeProductSyncService.REFRESH_SKEW_MS) return conn

    this.logger.log(`[shopee.sync] token perto do vencimento (${conn.expires_at}) — renovando conn=${conn.id}`)
    const adapter = this.registry.get('shopee')
    const tokens = await adapter.refreshToken(conn)
    await this.mp.updateTokens(conn.id, tokens)
    return {
      ...conn,
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:    tokens.expires_at,
    }
  }

  /** RawListing (get_item_base_info) → AlgoScoreInput. Só preenche o que vem do
   *  detalhe do anúncio; sinais de performance/loja ficam null (score neutro,
   *  sem issue falsa). main_image_url/item_sku são display-only (vão no snapshot
   *  pro Listing Center exibir). */
  private toAlgoInput(
    listing:     RawListing,
    shopId:      number,
    shopMetrics: ShopMetricsInput | null,
  ): AlgoScoreInput {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (listing.raw ?? {}) as any
    const imageUrls: string[] = Array.isArray(raw?.image?.image_url_list)
      ? raw.image.image_url_list
      : []
    const createTime = typeof raw?.create_time === 'number'
      ? new Date(raw.create_time * 1000).toISOString()
      : null

    return {
      shop_id:        shopId,
      item_id:        Number(listing.external_product_id),
      title:          listing.title ?? raw?.item_name ?? null,
      description:    typeof raw?.description === 'string' ? raw.description : null,
      image_count:    imageUrls.length || null,
      price:          listing.price ?? null,
      created_at:     createTime,
      shop_metrics:   shopMetrics,        // pilar seller_quality real (shop-level)
      main_image_url: imageUrls[0] ?? null,
      item_sku:       raw?.item_sku ?? null,
    }
  }

  /** Snapshot mais recente de shop_metrics da loja → ShopMetricsInput pro pilar
   *  seller_quality (shop-level, igual p/ todos os anúncios). Null-safe: sem
   *  snapshot (loja sem sync de métricas ainda) → null → pilar fica neutro 50
   *  (sem issue falsa). Lê via QualityService (mesma fonte da tela). */
  private async loadShopMetrics(orgId: string, shopId: number): Promise<ShopMetricsInput | null> {
    try {
      const cards = await this.quality.getLatest(orgId, shopId)
      const m = cards[0]?.metrics
      if (!m) return null
      return {
        chat_response_rate:     m.chat_response_rate     ?? null,
        chat_response_time_min: m.chat_response_time_min ?? null,
        prep_time_days:         m.prep_time_days         ?? null,
        late_ship_rate:         m.late_ship_rate         ?? null,
        return_refund_rate:     m.return_refund_rate     ?? null,
        rating:                 m.rating                 ?? null,
        penalty_points:         m.penalty_points         ?? null,
      }
    } catch (e: unknown) {
      this.logger.warn(`[shopee.sync] loadShopMetrics falhou: ${(e as Error)?.message}`)
      return null
    }
  }
}
