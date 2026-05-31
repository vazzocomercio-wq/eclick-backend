import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { MarketplaceService } from '../marketplace.service'
import { MarketplaceAdapterRegistry } from '../adapters/registry'
import { MpConnection, RawListing } from '../adapters/base'
import { ShopeeAlgoScoreService } from '../shopee-algo-score/shopee-algo-score.service'
import { AlgoScoreInput } from '../shopee-algo-score/algo-score.types'

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
  ) {}

  /** Sincroniza todos os anúncios NORMAL da loja Shopee conectada da org.
   *  Retorna resumo. Lança NotFound se a org não tem Shopee conectada. */
  async syncProducts(orgId: string): Promise<{
    shop_id:    number
    pages:      number
    items:      number
    scored:     number
    failed:     number
    started_at: string
  }> {
    const startedAt = new Date().toISOString()
    const resolved = await this.mp.resolve(orgId, 'shopee')
    if (!resolved) throw new NotFoundException('Loja Shopee não conectada nesta organização')

    let conn = resolved.conn
    const adapter = resolved.adapter
    conn = await this.ensureFreshToken(conn)

    if (!conn.shop_id) throw new NotFoundException('Conexão Shopee sem shop_id')
    const shopId = conn.shop_id

    let pages = 0
    let items = 0
    let scored = 0
    let failed = 0
    let cursor: string | null = null

    do {
      const page = await adapter.listProducts(conn, cursor)
      pages++
      for (const listing of page.items) {
        items++
        try {
          await this.algo.computeAndPersist(this.toAlgoInput(listing, shopId), orgId)
          scored++
        } catch (e: unknown) {
          failed++
          this.logger.warn(`[shopee.sync] score falhou item=${listing.external_product_id}: ${(e as Error)?.message}`)
        }
      }
      cursor = page.nextCursor
      if (pages >= ShopeeProductSyncService.MAX_PAGES) {
        this.logger.warn(`[shopee.sync] MAX_PAGES atingido (${pages}) — parando paginação`)
        break
      }
    } while (cursor)

    this.logger.log(`[shopee.sync] org=${orgId} shop=${shopId} pages=${pages} items=${items} scored=${scored} failed=${failed}`)
    return { shop_id: shopId, pages, items, scored, failed, started_at: startedAt }
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
  private toAlgoInput(listing: RawListing, shopId: number): AlgoScoreInput {
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
      main_image_url: imageUrls[0] ?? null,
      item_sku:       raw?.item_sku ?? null,
    }
  }
}
