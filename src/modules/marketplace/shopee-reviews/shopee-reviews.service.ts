import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { MarketplaceService } from '../marketplace.service'
import { ShopeeAdapter } from '../adapters/shopee.adapter'
import { ShopeeProductSyncService } from '../shopee-sync/shopee-product-sync.service'
import { LlmService } from '../../ai/llm.service'
import type { MpConnection } from '../adapters/base'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

/** Central de Avaliações — Shopee (1ª plataforma).
 *
 *  Ingestão shop-level via product/get_comment (cursor) → marketplace_reviews;
 *  resposta pública via product/reply_comment (ação do USER na tela — nada
 *  automático no MVP). IA sugere a resposta com contexto da avaliação +
 *  produto + loja (feature `shopee_review_reply`).
 *
 *  Por que importa: avaliação alimenta o Algorithm Score (ranking) e a
 *  taxa de resposta conta na saúde da loja. Nota ≤3 sem resposta = fila
 *  de prioridade. */
@Injectable()
export class ShopeeReviewsService {
  private readonly logger = new Logger(ShopeeReviewsService.name)
  private static readonly PAGE_SIZE = 50
  private static readonly MAX_PAGES = 60 // cap 3000 avaliações/loja/sync

  constructor(
    private readonly mp:          MarketplaceService,
    private readonly adapter:     ShopeeAdapter,
    private readonly productSync: ShopeeProductSyncService,
    private readonly llm:         LlmService,
  ) {}

  @Cron('35 */4 * * *', { name: 'shopee-reviews-sync' })
  async syncTick(): Promise<void> {
    if (process.env.SHOPEE_REVIEW_SYNC !== 'on') return
    const { data: rows } = await supabaseAdmin
      .from('marketplace_connections')
      .select('organization_id')
      .eq('platform', 'shopee')
      .eq('status', 'connected')
    const orgIds = [...new Set((rows ?? []).map(r => r.organization_id as string))]
    for (const orgId of orgIds) {
      try {
        await this.syncReviews(orgId)
      } catch (e) {
        this.logger.warn(`[shopee.reviews.cron] org=${orgId}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  /** Sincroniza avaliações de TODAS as lojas Shopee da org. Incremental:
   *  para de paginar quando a página inteira já é conhecida (sem update). */
  async syncReviews(orgId: string, opts: { full?: boolean } = {}): Promise<Array<{
    shop_id: number | null; reviews?: number; error?: string
  }>> {
    const conns = (await this.mp.listConnections(orgId)).filter(c => c.platform === 'shopee')
    if (conns.length === 0) throw new NotFoundException('Nenhuma loja Shopee conectada nesta organização')
    const out = []
    for (const c of conns) {
      try {
        out.push(await this.syncShop(orgId, c, opts.full ?? false))
      } catch (e) {
        this.logger.warn(`[shopee.reviews] shop=${c.shop_id} falhou: ${e instanceof Error ? e.message : e}`)
        out.push({ shop_id: c.shop_id ?? null, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return out
  }

  private async syncShop(orgId: string, baseConn: MpConnection, full: boolean): Promise<{
    shop_id: number; reviews: number
  }> {
    const conn = await this.productSync.ensureFreshToken(baseConn)
    if (!conn.shop_id) throw new NotFoundException('Conexão Shopee sem shop_id')
    const shopId = conn.shop_id

    let cursor = ''
    let saved = 0
    for (let page = 0; page < ShopeeReviewsService.MAX_PAGES; page++) {
      const { comments, more, nextCursor } = await this.adapter.listItemComments(conn, {
        cursor, pageSize: ShopeeReviewsService.PAGE_SIZE,
      })
      if (!comments.length) break

      let newOrChanged = 0
      for (const c of comments) {
        if (c?.comment_id == null) continue
        const replyText = c?.comment_reply?.reply ?? null
        const row = {
          organization_id:    orgId,
          platform:           'shopee',
          shop_id:            String(shopId),
          external_review_id: String(c.comment_id),
          item_id:            c.item_id != null ? String(c.item_id) : null,
          model_id:           c.model_id != null ? String(c.model_id) : null,
          order_sn:           c.order_sn ?? null,
          buyer_username:     c.buyer_username ?? null,
          rating:             Number(c.rating_star) || null,
          comment:            (c.comment ?? '').trim() || null,
          media:              c.media ?? {},
          reply_text:         replyText,
          editable:           c.editable ?? null,
          hidden:             c.hidden ?? null,
          review_create_at:   c.create_time ? new Date(c.create_time * 1000).toISOString() : null,
          raw:                c,
          updated_at:         new Date().toISOString(),
        }
        // upsert com detecção de novidade (incremental sem full-scan)
        const { data: prev } = await supabaseAdmin
          .from('marketplace_reviews')
          .select('id, reply_text')
          .eq('organization_id', orgId)
          .eq('platform', 'shopee')
          .eq('external_review_id', String(c.comment_id))
          .maybeSingle()
        const { error } = await supabaseAdmin
          .from('marketplace_reviews')
          .upsert(row, { onConflict: 'organization_id,platform,external_review_id' })
        if (error) { this.logger.warn(`[shopee.reviews] upsert ${c.comment_id}: ${error.message}`); continue }
        saved++
        if (!prev || (prev.reply_text ?? null) !== replyText) newOrChanged++
      }

      // página inteira já conhecida e sem mudança → resto é histórico (a API
      // devolve mais recentes primeiro). Em full sync, segue até o fim.
      if (!full && newOrChanged === 0) break
      if (!more || !nextCursor) break
      cursor = nextCursor
    }

    this.logger.log(`[shopee.reviews] org=${orgId} shop=${shopId} upserts=${saved}`)
    return { shop_id: shopId, reviews: saved }
  }

  // ── leitura pro front ─────────────────────────────────────────────────────

  async list(orgId: string, opts: {
    rating?: number; unreplied?: boolean; shopId?: string; withText?: boolean
    platform?: string  // 'shopee' | 'mercadolivre' | undefined = todas
    limit?: number; offset?: number
  } = {}): Promise<Json> {
    let q = supabaseAdmin
      .from('marketplace_reviews')
      .select('*', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('review_create_at', { ascending: false, nullsFirst: false })
      .range(opts.offset ?? 0, (opts.offset ?? 0) + Math.min(opts.limit ?? 60, 200) - 1)
    if (opts.platform)  q = q.eq('platform', opts.platform)
    if (opts.rating)    q = q.eq('rating', opts.rating)
    if (opts.unreplied) q = q.is('reply_text', null)
    if (opts.shopId)    q = q.eq('shop_id', opts.shopId)
    if (opts.withText)  q = q.not('comment', 'is', null)
    const { data, error, count } = await q
    if (error) throw new Error(`marketplace_reviews list: ${error.message}`)
    const reviews = (data ?? []) as Json[]

    // título do produto via vínculo anúncio↔produto (best-effort, por plataforma)
    const titleByItem = new Map<string, string>()
    for (const plat of ['shopee', 'mercadolivre']) {
      const itemIds = [...new Set(reviews.filter(r => r.platform === plat).map(r => r.item_id).filter(Boolean))] as string[]
      if (!itemIds.length) continue
      const { data: links } = await supabaseAdmin
        .from('product_listings')
        .select('listing_id, products(title)')
        .eq('platform', plat)
        .in('listing_id', itemIds)
      for (const l of (links ?? []) as Json[]) {
        if (l.products?.title) titleByItem.set(`${plat}:${l.listing_id}`, l.products.title as string)
      }
    }
    for (const r of reviews) r.product_title = titleByItem.get(`${r.platform}:${r.item_id}`) ?? null

    const { data: conns } = await supabaseAdmin
      .from('marketplace_connections')
      .select('shop_id, nickname')
      .eq('organization_id', orgId)
      .eq('platform', 'shopee')
    const shops = (conns ?? [])
      .filter(c => c.shop_id != null)
      .map(c => ({ shop_id: String(c.shop_id), nickname: (c.nickname as string) ?? `Shopee #${c.shop_id}` }))

    return { reviews, total: count ?? reviews.length, shops, kpis: await this.kpis(orgId, opts.platform) }
  }

  /** KPIs agregados (média, distribuição por estrela, respondidas, fila ≤3).
   *  Counts head-only via PostgREST — sem SQL interpolado. */
  private async kpis(orgId: string, platform?: string): Promise<Json> {
    const base = () => {
      let b = supabaseAdmin
        .from('marketplace_reviews')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
      if (platform) b = b.eq('platform', platform)
      return b
    }

    const [total, respondidas, negativasPendentes, ...porEstrela] = await Promise.all([
      base().then(r => r.count ?? 0),
      base().not('reply_text', 'is', null).then(r => r.count ?? 0),
      base().lte('rating', 3).is('reply_text', null).then(r => r.count ?? 0),
      ...[1, 2, 3, 4, 5].map(star => base().eq('rating', star).then(r => r.count ?? 0)),
    ])

    const dist: Record<string, number> = {}
    let soma = 0
    porEstrela.forEach((n, i) => { dist[String(i + 1)] = n; soma += n * (i + 1) })
    const rated = porEstrela.reduce((s, n) => s + n, 0)

    return {
      total,
      media: rated ? Math.round((soma / rated) * 100) / 100 : null,
      respondidas,
      negativas_pendentes: negativasPendentes,
      dist,
    }
  }

  // ── IA: resposta sugerida ─────────────────────────────────────────────────

  async suggest(orgId: string, reviewId: string): Promise<{ text: string }> {
    const review = await this.getReview(orgId, reviewId)
    const storeName = await this.storeName(orgId, review.shop_id as string)
    const title = await this.productTitle(review.item_id as string | null)

    const stars = Number(review.rating) || 0
    const out = await this.llm.generateText({
      orgId,
      feature: 'shopee_review_reply',
      systemPrompt:
        `Você responde avaliações públicas da loja "${storeName}" na Shopee Brasil. A resposta fica ` +
        `visível pra TODOS os futuros compradores — ela vende. Regras: português do Brasil, tom humano ` +
        `e caloroso (sem corporativês), máx 350 caracteres, sem links/contatos externos, sem prometer ` +
        `nada não confirmado. Avaliação positiva: agradeça com personalidade e reforce 1 qualidade do ` +
        `produto. Negativa/neutra: empatia genuína primeiro, peça desculpas se couber, diga a AÇÃO ` +
        `concreta (acionar a troca/devolução pela Shopee) — nunca discuta com o cliente. Responda APENAS ` +
        `com o texto, sem aspas.`,
      userPrompt:
        `Avaliação de ${review.buyer_username ?? 'cliente'} — ${stars} estrela(s)` +
        (title ? ` no produto "${title}"` : '') + `:\n` +
        `"${(review.comment as string | null) ?? '(sem texto, só a nota)'}"\n\n` +
        `Escreva a resposta pública do vendedor.`,
      maxTokens: 300,
    })
    return { text: out.text.trim() }
  }

  // ── resposta pública (⚠️ vai pro anúncio, não dá pra editar depois) ──────

  async reply(orgId: string, reviewId: string, text: string): Promise<Json> {
    const body = (text ?? '').trim()
    if (!body) throw new BadRequestException('Resposta vazia')
    if (body.length > 500) throw new BadRequestException('Resposta longa demais (máx 500)')

    const review = await this.getReview(orgId, reviewId)
    if (review.reply_text) throw new BadRequestException('Avaliação já respondida')
    if (review.editable && review.editable !== 'EDITABLE') {
      throw new BadRequestException('Janela de resposta expirada na Shopee')
    }

    const conns = (await this.mp.listConnections(orgId)).filter(c =>
      c.platform === 'shopee' && String(c.shop_id) === String(review.shop_id))
    if (!conns.length) throw new NotFoundException(`Loja Shopee ${review.shop_id} não conectada`)
    const conn = await this.productSync.ensureFreshToken(conns[0])

    await this.adapter.replyComments(conn, [{ commentId: review.external_review_id as string, comment: body }])

    await supabaseAdmin
      .from('marketplace_reviews')
      .update({ reply_text: body, replied_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', reviewId)

    return { replied: true }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async getReview(orgId: string, reviewId: string): Promise<Json> {
    const { data, error } = await supabaseAdmin
      .from('marketplace_reviews')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', reviewId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException('Avaliação não encontrada')
    return data
  }

  private async storeName(orgId: string, shopId: string | null): Promise<string> {
    if (!shopId) return 'a loja'
    const { data } = await supabaseAdmin
      .from('marketplace_connections')
      .select('nickname')
      .eq('organization_id', orgId)
      .eq('platform', 'shopee')
      .eq('shop_id', Number(shopId))
      .maybeSingle()
    return (data?.nickname as string | undefined) ?? 'a loja'
  }

  private async productTitle(itemId: string | null): Promise<string | null> {
    if (!itemId) return null
    const { data } = await supabaseAdmin
      .from('product_listings')
      .select('products(title)')
      .eq('platform', 'shopee')
      .eq('listing_id', itemId)
      .limit(1)
      .maybeSingle()
    return ((data as Json)?.products?.title as string | undefined) ?? null
  }
}
