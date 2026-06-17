import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { contentKeyFor, CHANNEL_TITLE_LIMITS, CHANNEL_LABELS, ChannelPlatform } from '../../common/channel-map'
import { linkProductListing } from '../../common/product-listing-link'
import { ShopeeCreativePublisherService } from '../marketplace/shopee-creative/shopee-creative.service'
import { ShopeeDraftListing } from '../marketplace/shopee-creative/shopee-creative.types'
import { TikTokShopService } from '../tiktok-shop/tiktok-shop.service'
import { ProductsService } from '../products/products.service'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import { LlmService } from '../ai/llm.service'
import { StockService } from '../stock/stock.service'
import { ShopeeStockSyncService } from '../marketplace/shopee-sync/shopee-stock-sync.service'
import { MarketplaceScrapingService } from '../marketplace-scraping/marketplace-scraping.service'
import { AccountLabelsService } from '../account-labels/account-labels.service'
import {
  MULTIPLIER_TARGETS, MultiplierTarget, MultiplierPayload, MultiplierDraft, MultiplierCandidate,
  MultiplierVariation,
} from './multiplier.types'

/** Campos do produto canônico que alimentam a proposta de multiplicação. */
const PRODUCT_FIELDS =
  'id, organization_id, name, sku, price, stock, brand, gtin, description, ' +
  'ai_long_description, ai_short_description, channel_titles, channel_descriptions, ' +
  'ml_title, ml_listing_type, photo_urls, images, weight_kg, width_cm, length_cm, height_cm, storefront_visible'

interface ProductRow {
  id: string
  organization_id: string | null
  name: string | null
  sku: string | null
  price: number | null
  stock: number | null
  brand: string | null
  gtin: string | null
  description: string | null
  ai_long_description: string | null
  ai_short_description: string | null
  channel_titles: Record<string, string> | null
  channel_descriptions: Record<string, string> | null
  ml_title: string | null
  ml_listing_type: string | null
  photo_urls: string[] | null
  images: unknown
  weight_kg: number | null
  width_cm: number | null
  length_cm: number | null
  height_cm: number | null
  storefront_visible: boolean | null
}

interface ListingRow {
  product_id: string
  platform: string
  account_id: string | null
  listing_id: string
  listing_title: string | null
  listing_price: number | null
}

/** Multiplicação de Anúncios — orquestrador (produto canônico → canal destino).
 *  Fluxo: candidatos (cobertura) → draft revisável → publish via publicador
 *  existente do canal. O vínculo em product_listings e a regra central de
 *  estoque acontecem DENTRO dos publicadores — aqui não se toca neles. */
@Injectable()
export class MultiplierService {
  private readonly logger = new Logger(MultiplierService.name)

  constructor(
    private readonly shopeePublisher: ShopeeCreativePublisherService,
    private readonly tiktok:          TikTokShopService,
    private readonly products:        ProductsService,
    private readonly mercadolivre:    MercadolivreService,
    private readonly llm:             LlmService,
    private readonly stock:           StockService,
    private readonly shopeeStock:     ShopeeStockSyncService,
    private readonly scraping:        MarketplaceScrapingService,
    private readonly accountLabels:   AccountLabelsService,
  ) {}

  // ── Destinos conectados ────────────────────────────────────────────────

  async getTargets(orgId: string): Promise<{
    mercadolivre: Array<{ seller_id: number; nickname: string | null }>
    shopee:       Array<{ shop_id: number; nickname: string | null }>
    tiktok_shop:  { connected: boolean }
    storefront:   { connected: boolean }
  }> {
    const [mlConns, shops, tiktokConn] = await Promise.all([
      this.mercadolivre.getConnections(orgId).catch(() => []),
      this.shopeePublisher.listShops(orgId).catch(() => [] as Array<{ shop_id: number; nickname: string | null }>),
      supabaseAdmin
        .from('tiktok_shop_credentials')
        .select('status')
        .eq('organization_id', orgId)
        .maybeSingle<{ status: string | null }>(),
    ])
    // nome real das contas (account_labels) — ML já vem resolvido do
    // getConnections; Shopee resolve aqui (listShops traz o apelido cru).
    const labels = await this.accountLabels.getMap(orgId).catch(() => ({} as Record<string, Record<string, string>>))
    const shopeeLabels = labels['shopee'] ?? {}
    return {
      mercadolivre: (mlConns as Array<{ seller_id: number | string; nickname: string | null }>)
        .filter(c => c.seller_id != null)
        .map(c => ({ seller_id: Number(c.seller_id), nickname: c.nickname ?? null })),
      shopee:       shops.map(s => ({ shop_id: s.shop_id, nickname: shopeeLabels[String(s.shop_id)] ?? s.nickname ?? null })),
      tiktok_shop:  { connected: tiktokConn.data?.status === 'connected' },
      storefront:   { connected: true },
    }
  }

  // ── Cópia em LOTE (página de anúncios → N contas/plataformas) ───────────
  //
  // Recebe N anúncios (product_id direto OU platform+listing_id pra resolver)
  // e N destinos (platform+account_id). Para cada combinação produto×destino:
  // pula se já coberto / se for o próprio anúncio de origem; senão cria o
  // rascunho (createDraft reusa toda a montagem/validação). publish=true →
  // publica em BACKGROUND (draft→publicando→publicado/falhou na fila), pra a
  // resposta voltar na hora sem timeout. Cap de 120 combinações por chamada.

  async batchCopy(orgId: string, userId: string, body: {
    items: Array<{ product_id?: string | null; platform?: string | null; listing_id?: string | null }>
    targets: Array<{ platform: MultiplierTarget; account_id?: string | null }>
    publish?: boolean
  }): Promise<{
    created: number; skipped: number; failed: number; publishing: number
    results: Array<{ product_id: string | null; target: string; status: 'created' | 'skipped' | 'failed'; draft_id?: string; reason?: string }>
  }> {
    const items = (body.items ?? []).filter(Boolean)
    const targets = (body.targets ?? []).filter(t => t?.platform)
    if (!items.length) throw new BadRequestException('Selecione ao menos um anúncio.')
    if (!targets.length) throw new BadRequestException('Escolha ao menos uma conta/plataforma de destino.')
    targets.forEach(t => this.assertTarget(t.platform))
    if (items.length * targets.length > 120) {
      throw new BadRequestException('Muitas combinações de uma vez (máx 120). Selecione menos anúncios ou menos destinos.')
    }

    // resolve product_id de cada item (direto, ou via product_listings)
    const resolved: Array<{ product_id: string | null; source_listing_id: string | null }> = []
    for (const it of items) {
      let pid = it.product_id ?? null
      if (!pid && it.platform && it.listing_id) {
        const { data } = await supabaseAdmin
          .from('product_listings')
          .select('product_id, products!inner(organization_id)')
          .eq('products.organization_id', orgId)
          .eq('platform', it.platform)
          .eq('listing_id', it.listing_id)
          .eq('is_active', true)
          .limit(1)
          .maybeSingle<{ product_id: string }>()
        pid = data?.product_id ?? null
      }
      resolved.push({ product_id: pid, source_listing_id: it.listing_id ?? null })
    }

    const results: Array<{ product_id: string | null; target: string; status: 'created' | 'skipped' | 'failed'; draft_id?: string; reason?: string }> = []
    const toPublish: string[] = []
    // drafts cujo created_at é anterior a isto = reaproveitados (já existiam),
    // não criados agora — 5s de folga pra latência.
    const startIso = new Date(Date.now() - 5000).toISOString()

    for (const r of resolved) {
      for (const t of targets) {
        const targetLabel = t.account_id ? `${t.platform}:${t.account_id}` : t.platform
        if (!r.product_id) {
          results.push({ product_id: null, target: targetLabel, status: 'failed', reason: 'Anúncio sem produto vinculado — vincule ou crie o produto antes de copiar.' })
          continue
        }
        try {
          const draft = await this.createDraft(orgId, userId, {
            product_id:        r.product_id,
            target_platform:   t.platform,
            target_account_id: t.account_id ?? null,
            source_listing_id: r.source_listing_id,
          })
          if (draft.status === 'published') {
            results.push({ product_id: r.product_id, target: targetLabel, status: 'skipped', draft_id: draft.id, reason: 'já publicado' })
          } else {
            const reused = (draft.created_at ?? '') < startIso
            results.push({ product_id: r.product_id, target: targetLabel, status: reused ? 'skipped' : 'created', draft_id: draft.id, reason: reused ? 'rascunho já existia na fila' : undefined })
            // publica mesmo o reaproveitado se publish=true (ele ainda não foi publicado)
            if (body.publish && (draft.status === 'draft' || draft.status === 'failed')) toPublish.push(draft.id)
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          // "já tem anúncio ativo" / "draft aberto" = pulado, não erro
          const skipped = /já tem anúncio ativo|já foi publicad/i.test(msg)
          results.push({ product_id: r.product_id, target: targetLabel, status: skipped ? 'skipped' : 'failed', reason: msg })
        }
      }
    }

    // publica em background — não bloqueia a resposta (evita timeout em lote)
    if (body.publish && toPublish.length) {
      for (const id of toPublish) {
        void this.publishDraft(orgId, userId, id)
          .catch(e => this.logger.warn(`[multiplier.batch] publish bg draft=${id}: ${(e as Error)?.message}`))
      }
    }

    const created = results.filter(r => r.status === 'created').length
    return {
      created,
      skipped: results.filter(r => r.status === 'skipped').length,
      failed:  results.filter(r => r.status === 'failed').length,
      publishing: body.publish ? toPublish.length : 0,
      results,
    }
  }

  // ── Candidatos (produto com anúncio em algum canal e sem anúncio no destino) ──

  async listCandidates(orgId: string, opts: {
    target: MultiplierTarget
    accountId?: string | null
    q?: string | null
    limit?: number
    offset?: number
  }): Promise<{ total: number; items: MultiplierCandidate[] }> {
    this.assertTarget(opts.target)
    const limit  = Math.min(Math.max(opts.limit ?? 50, 1), 200)
    const offset = Math.max(opts.offset ?? 0, 0)

    const listings = await this.fetchActiveListings(orgId)
    const byProduct = new Map<string, ListingRow[]>()
    for (const l of listings) {
      const arr = byProduct.get(l.product_id) ?? []
      arr.push(l)
      byProduct.set(l.product_id, arr)
    }

    // candidato = tem ≥1 anúncio ativo e NÃO está coberto no destino(+conta).
    // Com accountId (ML/Shopee multi-conta), cobre POR CONTA — produto com
    // anúncio na conta A é candidato pra conta B (multiplicação entre contas).
    const candidateIds: string[] = []
    for (const [pid, ls] of byProduct) {
      const covered = ls.some(l =>
        l.platform === opts.target &&
        (!opts.accountId || String(l.account_id) === String(opts.accountId)),
      )
      if (!covered) candidateIds.push(pid)
    }
    if (candidateIds.length === 0) return { total: 0, items: [] }

    // dados dos produtos (filtro q aplicado no banco, paginação em memória
    // sobre a lista de candidatos — escala atual: centenas de produtos)
    const rows: ProductRow[] = []
    for (let i = 0; i < candidateIds.length; i += 200) {
      let qb = supabaseAdmin
        .from('products')
        .select(PRODUCT_FIELDS)
        .eq('organization_id', orgId)
        .in('id', candidateIds.slice(i, i + 200))
      if (opts.q?.trim()) qb = qb.or(`name.ilike.%${opts.q.trim()}%,sku.ilike.%${opts.q.trim()}%`)
      const { data, error } = await qb
      if (error) throw new BadRequestException(`listCandidates: ${error.message}`)
      rows.push(...((data ?? []) as unknown as ProductRow[]))
    }

    rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    const page = rows.slice(offset, offset + limit)

    const items: MultiplierCandidate[] = page.map(p => {
      const photos = this.collectImageUrls(p)
      const covered = (byProduct.get(p.id) ?? []).map(l =>
        l.account_id ? `${l.platform}:${l.account_id}` : l.platform,
      )
      return {
        product_id:  p.id,
        name:        p.name ?? '(sem nome)',
        sku:         p.sku,
        price:       p.price,
        stock:       p.stock,
        photo_count: photos.length,
        thumbnail:   photos[0] ?? null,
        covered:     [...new Set(covered)],
        warnings:    this.publishWarnings(opts.target, p, photos),
      }
    })

    return { total: rows.length, items }
  }

  /** Cobertura de anúncios ativos por produto ('platform:account_id'[]) —
   *  alimenta os chips da lista de Produtos. Lote de até 200 ids. */
  async getCoverage(orgId: string, productIds: string[]): Promise<Record<string, string[]>> {
    const ids = [...new Set((productIds ?? []).filter(Boolean))].slice(0, 200)
    if (ids.length === 0) return {}
    const { data, error } = await supabaseAdmin
      .from('product_listings')
      .select('product_id, platform, account_id, products!inner(organization_id)')
      .eq('products.organization_id', orgId)
      .eq('is_active', true)
      .in('product_id', ids)
    if (error) throw new BadRequestException(`getCoverage: ${error.message}`)
    const out: Record<string, string[]> = {}
    for (const r of (data ?? []) as unknown as Array<{ product_id: string; platform: string; account_id: string | null }>) {
      const key = r.account_id ? `${r.platform}:${r.account_id}` : r.platform
      const arr = out[r.product_id] ?? []
      if (!arr.includes(key)) arr.push(key)
      out[r.product_id] = arr
    }
    return out
  }

  // ── Drafts ─────────────────────────────────────────────────────────────

  async createDraft(orgId: string, userId: string, body: {
    product_id: string
    target_platform: MultiplierTarget
    target_account_id?: string | null
    source_listing_id?: string | null
    /** VARIAÇÕES (Shopee): demais produtos do grupo + rótulo (o produto base
     *  entra automaticamente se não vier na lista). */
    variations?: Array<{ product_id: string; label: string }>
    variation_tier_name?: string
  }): Promise<MultiplierDraft> {
    this.assertTarget(body.target_platform)
    if (!body.product_id) throw new BadRequestException('product_id obrigatório')

    const product = await this.fetchProduct(orgId, body.product_id)

    // resolve conta destino (Shopee/ML multi-conta)
    let accountId: string | null = body.target_account_id ?? null
    if (body.target_platform === 'shopee' && !accountId) {
      const shops = await this.shopeePublisher.listShops(orgId)
      if (shops.length === 0) throw new BadRequestException('Nenhuma loja Shopee conectada.')
      if (shops.length > 1) {
        throw new BadRequestException('Mais de uma loja Shopee conectada — informe target_account_id (shop_id).')
      }
      accountId = String(shops[0].shop_id)
    }
    if (body.target_platform === 'mercadolivre' && !accountId) {
      const conns = await this.mercadolivre.getConnections(orgId)
      if (!conns.length) throw new BadRequestException('Nenhuma conta Mercado Livre conectada.')
      if (conns.length > 1) {
        throw new BadRequestException('Mais de uma conta ML conectada — informe target_account_id (seller_id).')
      }
      accountId = String((conns[0] as { seller_id: number | string }).seller_id)
    }

    // já coberto no destino(+conta)? não duplica anúncio
    const listings = await this.fetchActiveListings(orgId, body.product_id)
    const dup = listings.find(l =>
      l.platform === body.target_platform &&
      (!accountId || String(l.account_id) === String(accountId)),
    )
    if (dup) {
      throw new BadRequestException(
        `Este produto já tem anúncio ativo em ${CHANNEL_LABELS[body.target_platform as ChannelPlatform]} (${dup.listing_id}).`,
      )
    }

    // draft aberto pro mesmo destino → retorna o existente (idempotente)
    const { data: open } = await supabaseAdmin
      .from('multiplier_drafts')
      .select('*')
      .eq('organization_id', orgId)
      .eq('product_id', body.product_id)
      .eq('target_platform', body.target_platform)
      .in('status', ['draft', 'publishing'])
      .limit(5)
    const sameAccount = (open ?? []).find(d =>
      String((d as { target_account_id: string | null }).target_account_id ?? '') === String(accountId ?? ''))
    if (sameAccount) {
      const existing = sameAccount as unknown as MultiplierDraft
      // veio um grupo de variações novo → mescla no rascunho aberto (senão a
      // idempotência devolveria o antigo ignorando o pedido)
      if (body.variations?.length) {
        return this.updateDraft(orgId, existing.id, {
          variations: body.variations.map(v => ({ product_id: v.product_id, label: v.label, price: null, sku: null })),
          variation_tier_name: (body.variation_tier_name ?? 'Cor').trim() || 'Cor',
        })
      }
      return existing
    }

    // conteúdo de origem: anúncio escolhido OU melhor anúncio existente (ML primeiro)
    let source: ListingRow | null = null
    if (body.source_listing_id) {
      source = listings.find(l => l.listing_id === body.source_listing_id) ?? null
      if (!source) throw new BadRequestException('source_listing_id não é um anúncio ativo deste produto.')
    } else {
      source = listings.find(l => l.platform === 'mercadolivre') ?? listings[0] ?? null
    }

    const payload = await this.buildPayload(orgId, body.target_platform, product, source)

    // VARIAÇÕES (Shopee MVP): valida e enriquece o grupo já no draft
    if (body.variations?.length) {
      if (body.target_platform !== 'shopee') {
        throw new BadRequestException('Variações: por enquanto só com destino Shopee (ML/TikTok na próxima fase).')
      }
      payload.variations = await this.buildVariations(orgId, body.product_id, body.variations, payload)
      payload.variation_tier_name = (body.variation_tier_name ?? 'Cor').trim() || 'Cor'
    }

    const { data, error } = await supabaseAdmin
      .from('multiplier_drafts')
      .insert({
        organization_id:   orgId,
        product_id:        body.product_id,
        source_platform:   source?.platform ?? null,
        source_listing_id: source?.listing_id ?? null,
        target_platform:   body.target_platform,
        target_account_id: accountId,
        payload,
        status:            'draft',
        created_by:        userId,
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`createDraft: ${error.message}`)
    return data as unknown as MultiplierDraft
  }

  async listDrafts(orgId: string, opts: { status?: string | null; limit?: number; offset?: number }): Promise<MultiplierDraft[]> {
    const limit  = Math.min(Math.max(opts.limit ?? 50, 1), 200)
    const offset = Math.max(opts.offset ?? 0, 0)
    let qb = supabaseAdmin
      .from('multiplier_drafts')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)
    if (opts.status?.trim()) qb = qb.eq('status', opts.status.trim())
    const { data, error } = await qb
    if (error) throw new BadRequestException(`listDrafts: ${error.message}`)
    return (data ?? []) as unknown as MultiplierDraft[]
  }

  async updateDraft(orgId: string, draftId: string, patch: Partial<MultiplierPayload>): Promise<MultiplierDraft> {
    const draft = await this.fetchDraft(orgId, draftId)
    if (draft.status !== 'draft' && draft.status !== 'failed') {
      throw new BadRequestException(`Draft em status '${draft.status}' não pode ser editado.`)
    }

    const allowed: Array<keyof MultiplierPayload> = [
      'title', 'description', 'price', 'image_urls', 'sku', 'brand', 'gtin',
      'weight_kg', 'package_dimensions_cm', 'stock', 'category_id',
      'listing_type', 'condition', 'variations', 'variation_tier_name',
    ]
    const merged: MultiplierPayload = { ...draft.payload }
    for (const k of allowed) {
      if (patch[k] !== undefined) (merged as unknown as Record<string, unknown>)[k] = patch[k] as unknown
    }
    if (merged.title) {
      merged.title = merged.title.trim().slice(0, CHANNEL_TITLE_LIMITS[draft.target_platform as ChannelPlatform] ?? 255)
    }
    // edição do grupo de variações passa pelas MESMAS validações da criação
    if (patch.variations !== undefined) {
      if (patch.variations && patch.variations.length > 0) {
        if (draft.target_platform !== 'shopee') {
          throw new BadRequestException('Variações: por enquanto só com destino Shopee.')
        }
        merged.variations = await this.buildVariations(
          orgId, draft.product_id,
          patch.variations.map(v => ({ product_id: v.product_id, label: v.label })),
          merged,
        )
      } else {
        merged.variations = null
      }
    }

    const { data, error } = await supabaseAdmin
      .from('multiplier_drafts')
      .update({ payload: merged, status: 'draft', error_message: null, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', draftId)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`updateDraft: ${error.message}`)
    return data as unknown as MultiplierDraft
  }

  async discardDraft(orgId: string, draftId: string): Promise<{ ok: true }> {
    const draft = await this.fetchDraft(orgId, draftId)
    if (draft.status === 'publishing') throw new BadRequestException('Draft publicando — aguarde terminar.')
    const { error } = await supabaseAdmin
      .from('multiplier_drafts')
      .update({ status: 'discarded', updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', draftId)
    if (error) throw new BadRequestException(`discardDraft: ${error.message}`)
    return { ok: true }
  }

  // ── Publish (despacho pro publicador do destino) ───────────────────────

  async publishDraft(orgId: string, userId: string, draftId: string): Promise<MultiplierDraft> {
    const draft = await this.fetchDraft(orgId, draftId)
    if (draft.status !== 'draft' && draft.status !== 'failed') {
      throw new BadRequestException(`Draft em status '${draft.status}' não pode ser publicado.`)
    }

    await this.setDraftStatus(orgId, draftId, { status: 'publishing', error_message: null })

    try {
      let externalId: string
      if (draft.target_platform === 'storefront') {
        externalId = await this.publishToStorefront(orgId, draft)
      } else if (draft.target_platform === 'shopee') {
        externalId = await this.publishToShopee(orgId, draft)
      } else if (draft.target_platform === 'tiktok_shop') {
        externalId = await this.publishToTikTok(orgId, draft)
      } else if (draft.target_platform === 'mercadolivre') {
        externalId = await this.publishToMercadoLivre(orgId, draft)
      } else {
        throw new BadRequestException(`Destino '${draft.target_platform}' não suportado.`)
      }

      await this.setDraftStatus(orgId, draftId, {
        status: 'published', external_id: externalId, published_at: new Date().toISOString(),
      })
      this.logger.log(`[multiplier] publicado draft=${draftId} target=${draft.target_platform} external=${externalId} user=${userId}`)
      return await this.fetchDraft(orgId, draftId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await this.setDraftStatus(orgId, draftId, { status: 'failed', error_message: msg.slice(0, 1000) })
      this.logger.warn(`[multiplier] publish falhou draft=${draftId} target=${draft.target_platform}: ${msg}`)
      throw e instanceof BadRequestException ? e : new BadRequestException(msg)
    }
  }

  private async publishToStorefront(orgId: string, draft: MultiplierDraft): Promise<string> {
    // A loja lê products.name/price — se o produto está sem preço (ou nome) e o
    // rascunho revisado tem, completa o cadastro com o valor REVISADO antes de
    // publicar (só preenche o que está vazio; nunca sobrescreve valor existente).
    const p = draft.payload
    const { data: prod } = await supabaseAdmin
      .from('products')
      .select('id, name, price')
      .eq('organization_id', orgId)
      .eq('id', draft.product_id)
      .maybeSingle<{ id: string; name: string | null; price: number | null }>()
    const patch: Record<string, unknown> = {}
    if (prod && (!prod.price || prod.price <= 0) && p.price && p.price > 0) patch.price = p.price
    if (prod && !prod.name?.trim() && p.title?.trim()) patch.name = p.title.trim()
    if (Object.keys(patch).length > 0) {
      await supabaseAdmin.from('products').update(patch).eq('id', draft.product_id)
      this.logger.log(`[multiplier.loja] cadastro completado pelo rascunho ${draft.id}: ${Object.keys(patch).join(', ')}`)
    }

    const res = await this.products.setStorefrontVisibility(orgId, [draft.product_id], true)
    if (res.updated === 0) {
      throw new BadRequestException('Produto sem nome ou sem preço — informe o preço no rascunho (ou no cadastro) antes de publicar na loja.')
    }
    return draft.product_id
  }

  private async publishToShopee(orgId: string, draft: MultiplierDraft): Promise<string> {
    const p = draft.payload
    const imageUrls = await this.resolveImagesForPublish(orgId, draft)
    if (!imageUrls.length) {
      throw new BadRequestException(
        'Sem foto válida: as imagens do anúncio de origem ainda estão "processando" no ML. ' +
        'Aguarde o ML processar (ou adicione fotos no produto) e tente de novo.',
      )
    }

    const hasVariations = (p.variations?.length ?? 0) >= 2
    const shopeeDraft: ShopeeDraftListing = {
      shop_id:            Number(draft.target_account_id ?? 0),
      product_id:         draft.product_id,
      // COM variações: o publisher NÃO vincula nem empurra estoque (vínculo é
      // por model, feito abaixo). Sem variações: fluxo clássico (1:1).
      catalog_product_id: hasVariations ? null : draft.product_id,
      title:              p.title,
      description:        p.description,
      price:              p.price,
      image_count:        imageUrls.length || null,
      image_urls:         imageUrls.length ? imageUrls : null,
      weight_kg:          p.weight_kg,
      package_length_cm:  p.package_dimensions_cm?.length ?? null,
      package_width_cm:   p.package_dimensions_cm?.width ?? null,
      package_height_cm:  p.package_dimensions_cm?.height ?? null,
      brand:              p.brand,
    }
    const res = await this.shopeePublisher.publish(orgId, shopeeDraft)
    if (!res.ok || !res.item_id) {
      throw new BadRequestException(
        `Shopee bloqueou a publicação:\n• ${(res.blockers ?? ['erro desconhecido']).join('\n• ')}`,
      )
    }
    const itemId = res.item_id

    if (hasVariations) {
      await this.attachShopeeVariations(orgId, draft, itemId, p.variations as MultiplierVariation[])
    }
    return String(itemId)
  }

  /** Fase 2 do publish com variações: cria os tiers/models no item, vincula
   *  CADA model ao SEU produto do catálogo e dispara o estoque por variação. */
  private async attachShopeeVariations(
    orgId: string,
    draft: MultiplierDraft,
    itemId: number,
    variations: MultiplierVariation[],
  ): Promise<void> {
    const tierName = draft.payload.variation_tier_name?.trim() || 'Cor'
    const fallbackPrice = draft.payload.price ?? 0

    let models: Array<{ model_id: number; tier_index: number[] }>
    try {
      models = await this.shopeePublisher.initVariations(orgId, Number(draft.target_account_id ?? 0), {
        itemId,
        tierName,
        options: variations.map(v => v.label),
        models:  variations.map((v, i) => ({
          tierIndex: i,
          price:     v.price ?? fallbackPrice,
          sku:       v.sku ?? null,
        })),
      })
    } catch (e) {
      // item já existe — erro aqui é PARCIAL e precisa ser explícito
      throw new BadRequestException(
        `Anúncio ${itemId} criado, mas as VARIAÇÕES falharam: ${(e as Error)?.message}. ` +
        'Corrija na Shopee ou apague o item e publique de novo.',
      )
    }

    // model → variação pela posição do tier_index (mesma ordem das options)
    const byTier = new Map<number, number>()
    for (const m of models) byTier.set(m.tier_index?.[0] ?? -1, m.model_id)

    for (let i = 0; i < variations.length; i++) {
      const v = variations[i]
      const modelId = byTier.get(i)
      if (!modelId) {
        this.logger.warn(`[multiplier.shopee] model do tier ${i} (${v.label}) não retornado — vínculo manual depois`)
        continue
      }
      try {
        await supabaseAdmin.from('product_listings').upsert({
          platform:      'shopee',
          account_id:    String(draft.target_account_id ?? ''),
          listing_id:    String(itemId),
          variation_id:  String(modelId),
          product_id:    v.product_id,
          listing_title: `${draft.payload.title} — ${v.label}`,
          listing_price: v.price ?? fallbackPrice,
          is_active:     true,
        }, { onConflict: 'platform,account_id,listing_id,variation_id,product_id' })
      } catch (e) {
        this.logger.warn(`[multiplier.shopee] vínculo model=${modelId} produto=${v.product_id} falhou: ${(e as Error)?.message}`)
      }
      // estoque da variação (motor central, por model via vínculo recém-criado)
      try {
        await this.shopeeStock.pushStockForProduct(v.product_id, { bypassGate: true })
      } catch (e) {
        this.logger.warn(`[multiplier.shopee] estoque variação ${v.label} falhou: ${(e as Error)?.message}`)
      }
    }
    this.logger.log(`[multiplier.shopee] item=${itemId} com ${variations.length} variações (${tierName}) vinculadas`)
  }

  /** Valida e enriquece o grupo de variações no draft. O produto base entra
   *  automaticamente (rótulo 'Principal') se não vier na lista. */
  private async buildVariations(
    orgId: string,
    baseProductId: string,
    input: Array<{ product_id: string; label: string }>,
    payload: MultiplierPayload,
  ): Promise<MultiplierVariation[]> {
    const list = (input ?? [])
      .filter(v => v?.product_id)
      .map(v => ({ product_id: v.product_id, label: String(v.label ?? '').trim() }))

    if (!list.some(v => v.product_id === baseProductId)) {
      list.unshift({ product_id: baseProductId, label: 'Principal' })
    }
    if (list.length < 2) throw new BadRequestException('Variações: informe pelo menos 2 opções (produtos).')
    if (list.length > 50) throw new BadRequestException('Variações: máximo de 50 opções.')

    const ids = list.map(v => v.product_id)
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Variações: produto repetido no grupo.')
    const labels = list.map(v => v.label.toLowerCase())
    if (list.some(v => !v.label)) throw new BadRequestException('Variações: cada opção precisa de um rótulo (ex.: cor).')
    if (new Set(labels).size !== labels.length) throw new BadRequestException('Variações: rótulo repetido no grupo.')

    const { data: prods, error } = await supabaseAdmin
      .from('products')
      .select('id, name, sku, price, stock')
      .eq('organization_id', orgId)
      .in('id', ids)
    if (error) throw new BadRequestException(`buildVariations: ${error.message}`)
    const byId = new Map((prods ?? []).map(pr => [pr.id as string, pr as { id: string; name: string | null; sku: string | null; price: number | null; stock: number | null }]))
    const missing = ids.filter(id => !byId.has(id))
    if (missing.length) throw new BadRequestException('Variações: produto fora do catálogo desta organização.')

    return list.map(v => {
      const pr = byId.get(v.product_id)
      return {
        product_id: v.product_id,
        label:      v.label,
        price:      pr?.price ?? payload.price ?? null,
        sku:        pr?.sku ?? null,
        name:       pr?.name ?? null,
        stock:      pr?.stock ?? null,
      }
    })
  }

  private async publishToTikTok(orgId: string, draft: MultiplierDraft): Promise<string> {
    const p = draft.payload
    let categoryId = p.category_id ?? null
    if (!categoryId) {
      const rec = await this.tiktok.recommendCategory(orgId, {
        product_name: p.title, description: p.description ?? undefined,
      })
      categoryId = rec.category_id
    }
    if (!categoryId) {
      throw new BadRequestException(
        'TikTok não recomendou categoria pra este título — edite o draft e informe category_id.',
      )
    }
    const ttImages = await this.resolveImagesForPublish(orgId, draft)
    if (!ttImages.length) throw new BadRequestException('Produto sem foto válida — adicione imagens antes de publicar no TikTok.')

    const res = await this.tiktok.publishProduct(orgId, {
      title:                 p.title,
      description:           p.description ?? undefined,
      category_id:           categoryId,
      image_urls:            ttImages,
      price:                 p.price ?? 0,
      stock:                 p.stock ?? 0,
      sku:                   p.sku ?? undefined,
      package_weight_kg:     p.weight_kg ?? undefined,
      package_dimensions_cm: p.package_dimensions_cm ?? undefined,
      brand_name:            p.brand ?? undefined,
    })
    if (!res.product_id) throw new BadRequestException('TikTok não retornou product_id.')
    return String(res.product_id)
  }

  /** Publica no Mercado Livre direto do produto canônico (POST /items).
   *  Categoria: payload.category_id (editável no draft) ou re-prevista.
   *  Atributos: determinísticos (SELLER_SKU/BRAND/GTIN/dimensões) + IA pros
   *  obrigatórios restantes. Anúncio nasce PAUSADO — revisão no painel ML. */
  private async publishToMercadoLivre(orgId: string, draft: MultiplierDraft): Promise<string> {
    const p = draft.payload
    const mlImages = await this.resolveImagesForPublish(orgId, draft)
    if (!mlImages.length) throw new BadRequestException('Produto sem foto válida — adicione imagens antes de publicar no ML.')
    if (!p.price || p.price <= 0) throw new BadRequestException('Preço obrigatório pra publicar no ML.')

    const sellerHint = Number(draft.target_account_id)
    const { token, sellerId } = await this.mercadolivre.getTokenForOrg(
      orgId, Number.isFinite(sellerHint) && sellerHint > 0 ? sellerHint : undefined,
    )

    let categoryId = p.category_id ?? null
    if (!categoryId) {
      const pred = await this.mercadolivre.predictCategory(p.title)
      categoryId = pred.category_id
    }
    if (!categoryId) {
      throw new BadRequestException('ML não previu categoria pra este título — edite o draft e informe category_id.')
    }

    const attributes = await this.buildMlAttributes(orgId, draft, categoryId)

    // family_name: obrigatório em categorias de catálogo (ex.: iluminação);
    // o ML valida consistência título×família — usar o próprio título garante.
    // Categorias que não exigem simplesmente ignoram (mesmo padrão do Criativo).
    const mlPayload: Record<string, unknown> = {
      title:              p.title.slice(0, 60),
      family_name:        p.title.slice(0, 60),
      category_id:        categoryId,
      price:              p.price,
      currency_id:        'BRL',
      available_quantity: Math.max(0, Math.round(Number(p.stock) || 0)),
      buying_mode:        'buy_it_now',
      listing_type_id:    this.normalizeMlListingType(p.listing_type),
      condition:          p.condition ?? 'new',
      pictures:           mlImages.slice(0, 10).map(u => ({ source: u })),
      attributes,
      // nasce PAUSADO — mesmo padrão do IA Criativo: user revisa e ativa no ML.
      status:             'paused',
    }
    if (p.description?.trim()) mlPayload.description = { plain_text: p.description.trim() }

    let itemId: string
    const cfg = { headers: { Authorization: `Bearer ${token}` }, timeout: 60_000 }
    try {
      const { data } = await axios.post<{ id: string }>('https://api.mercadolibre.com/items', mlPayload, cfg)
      itemId = String(data.id)
    } catch (e) {
      // Categorias de catálogo/família (ex.: iluminação) GERAM o título a
      // partir do family_name e rejeitam `title` no corpo (invalid_fields
      // [title]) — reenvia sem title (mesmo fallback do IA Criativo).
      if (this.isMlTitleRejected(e) && 'title' in mlPayload) {
        this.logger.log('[multiplier.ml] categoria gera o título — reenviando sem `title`')
        const retry = { ...mlPayload }
        delete retry.title
        try {
          const { data } = await axios.post<{ id: string }>('https://api.mercadolibre.com/items', retry, cfg)
          itemId = String(data.id)
        } catch (e2) {
          throw new BadRequestException(this.formatMlError(e2))
        }
      } else {
        throw new BadRequestException(this.formatMlError(e))
      }
    }

    // vínculo produto↔anúncio (conta dona) + estoque na esteira central
    try {
      await linkProductListing({
        platform:  'mercadolivre',
        listingId: itemId,
        productId: draft.product_id,
        accountId: String(sellerId),
        title:     p.title,
        price:     p.price,
      })
      void this.stock.recalcAndPropagate(draft.product_id, 'multiplier_ml_publish')
        .catch(e => this.logger.warn(`[multiplier.ml] recalc pós-publish: ${(e as Error)?.message}`))
    } catch (e) {
      this.logger.warn(`[multiplier.ml] vínculo falhou item=${itemId}: ${(e as Error)?.message}`)
    }

    this.logger.log(`[multiplier.ml] publicado item=${itemId} seller=${sellerId} produto=${draft.product_id} (pausado)`)
    return itemId
  }

  /** Atributos ML: determinísticos + IA pros obrigatórios da categoria. */
  private async buildMlAttributes(
    orgId: string,
    draft: MultiplierDraft,
    categoryId: string,
  ): Promise<Array<{ id: string; value_id?: string; value_name?: string }>> {
    const p = draft.payload
    type MlAttr = {
      id: string; name: string; value_type: string
      values?: Array<{ id: string; name: string }>
      tags?: Record<string, boolean>
    }
    const all = (await this.mercadolivre.getCategoryAttributes(categoryId).catch(() => [])) as MlAttr[]
    const byId = new Map<string, MlAttr>(all.map(a => [a.id, a] as [string, MlAttr]))
    const out = new Map<string, { id: string; value_id?: string; value_name?: string }>()

    const setIfAttr = (id: string, value: string | null | undefined) => {
      const attr = byId.get(id)
      const raw = (value ?? '').trim()
      if (!attr || !raw || out.has(id)) return
      if (attr.values?.length) {
        const opt = attr.values.find(o => o.name.toLowerCase().trim() === raw.toLowerCase().trim())
        if (opt) { out.set(id, { id, value_id: opt.id, value_name: opt.name }); return }
        if (attr.value_type !== 'string') return // lista fechada sem match → não força
      }
      out.set(id, { id, value_name: raw })
    }

    // determinísticos — dados que JÁ conhecemos do produto
    setIfAttr('SELLER_SKU', p.sku)
    setIfAttr('BRAND',      p.brand)
    setIfAttr('GTIN',       p.gtin)
    if (p.package_dimensions_cm) {
      setIfAttr('SELLER_PACKAGE_HEIGHT', `${p.package_dimensions_cm.height} cm`)
      setIfAttr('SELLER_PACKAGE_WIDTH',  `${p.package_dimensions_cm.width} cm`)
      setIfAttr('SELLER_PACKAGE_LENGTH', `${p.package_dimensions_cm.length} cm`)
    }
    if (p.weight_kg) setIfAttr('SELLER_PACKAGE_WEIGHT', `${Math.round(p.weight_kg * 1000)} g`)

    // obrigatórios restantes → IA (nunca inventa; sem confiança = deixa de fora
    // e o erro do ML aponta o que falta, acionável no draft)
    const required = all.filter(a => {
      const t = a.tags ?? {}
      return (t.required || t.catalog_required || t.conditional_required)
        && a.value_type !== 'picture_id' && !out.has(a.id)
    })
    if (required.length > 0) {
      try {
        const attrLines = required.map(a => {
          const opts = (a.values ?? []).map(v => v.name).filter(Boolean)
          const spec = opts.length ? `escolha UMA opção exata: ${opts.slice(0, 60).join(' | ')}`
            : a.value_type === 'boolean' ? 'responda "Sim" ou "Não"'
            : a.value_type === 'number_unit' ? 'número com unidade (ex: "40 W", "30 cm")'
            : a.value_type === 'number' ? 'número' : 'texto curto'
          return `- ${a.id} ("${a.name}") — ${spec}`
        }).join('\n')

        const outLlm = await this.llm.generateText({
          orgId,
          feature:    'creative_listing',
          userPrompt: [
            'Você preenche a ficha técnica de um anúncio do Mercado Livre.',
            '',
            'PRODUTO:',
            `- Título: ${p.title}`,
            `- Marca: ${p.brand ?? '—'}`,
            `- Descrição: ${(p.description ?? '').slice(0, 2000)}`,
            '',
            'ATRIBUTOS OBRIGATÓRIOS A PREENCHER:',
            attrLines,
            '',
            'REGRAS:',
            '- Preencha apenas o que der pra deduzir COM CONFIANÇA dos dados acima.',
            '- Para atributos com opções, use EXATAMENTE uma das opções listadas.',
            '- Se não der pra determinar, omita o atributo.',
            '- NUNCA invente valores.',
            '',
            'Responda só JSON: {"attributes":[{"id":"X","value":"Y"}]}',
          ].join('\n'),
          jsonMode:  true,
          maxTokens: 1500,
        })
        // o modelo às vezes embrulha em cerca markdown (```json … ```)
        const cleaned = outLlm.text.trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```\s*$/, '')
        const parsed = JSON.parse(cleaned) as { attributes?: Array<{ id?: string; value?: string }> }
        for (const it of parsed?.attributes ?? []) {
          const id = String(it?.id ?? '').trim()
          if (id && byId.has(id)) setIfAttr(id, it?.value == null ? null : String(it.value))
        }
      } catch (e) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body = (e as any)?.response?.data
        this.logger.warn(
          `[multiplier.ml] IA de atributos falhou (segue sem): ${(e as Error)?.message}` +
          (body ? ` — ${JSON.stringify(body).slice(0, 300)}` : ''),
        )
      }
    }

    // fallback determinístico final: MODEL é obrigatório em muitas categorias
    // e aceita texto livre — usa o SKU (prática padrão de integradores) quando
    // nem a IA preencheu.
    if (!out.has('MODEL') && byId.has('MODEL')) {
      setIfAttr('MODEL', p.sku ?? p.title.slice(0, 60))
    }

    this.logger.log(`[multiplier.ml] atributos montados: ${[...out.keys()].join(', ') || '(nenhum)'}`)
    return [...out.values()]
  }

  /** ML rejeitou especificamente o campo title? (categorias de família) */
  private isMlTitleRejected(e: unknown): boolean {
    if (!axios.isAxiosError(e)) return false
    const data = e.response?.data as
      | { error?: string; message?: string; cause?: Array<{ message?: string }> }
      | undefined
    if (!data) return false
    const text = [
      data.error ?? '', data.message ?? '',
      ...(data.cause ?? []).map(c => c?.message ?? ''),
    ].join(' ').toLowerCase()
    return text.includes('[title]') && text.includes('invalid')
  }

  /** Normaliza o tipo de anúncio pro id que a API do ML aceita —
   *  products.ml_listing_type guarda apelidos ('classic', 'premium'). */
  private normalizeMlListingType(v: string | null | undefined): string {
    const s = (v ?? '').toLowerCase().trim()
    if (s === 'classic' || s === 'classico' || s === 'clássico') return 'gold_special'
    if (s === 'premium') return 'gold_pro'
    if (['free', 'bronze', 'silver', 'gold', 'gold_special', 'gold_premium', 'gold_pro'].includes(s)) return s
    return 'gold_special'
  }

  /** Erro do ML → mensagem acionável em PT-BR (lista as causes). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private formatMlError(e: any): string {
    const data = e?.response?.data
    if (!data) return e instanceof Error ? e.message : String(e)
    const causes = Array.isArray(data.cause)
      ? data.cause.map((c: { message?: string; code?: string }) => c?.message ?? c?.code).filter(Boolean)
      : []
    const head = data.message ?? 'Mercado Livre recusou a publicação'
    if (causes.length) return `${head}:\n• ${causes.join('\n• ')}`
    // sem causes legíveis → expõe o corpo bruto (truncado) pra não esconder o campo
    try { return `${head} — detalhe: ${JSON.stringify(data).slice(0, 600)}` } catch { return String(head) }
  }

  // ── Importar anúncio de CONCORRENTE ────────────────────────────────────
  //
  // URL de anúncio ML/Shopee → scrape (título/preço/fotos) + enriquecimento
  // ML (descrição + marca/GTIN/modelo dos atributos públicos) → cria PRODUTO
  // rascunho no catálogo (SKU IMP-{listing}) → opcionalmente já abre um
  // rascunho de multiplicação pro destino escolhido. ⚠️ conteúdo de terceiro:
  // a UI avisa pra revisar fotos/textos (direitos autorais) antes de publicar.

  async importCompetitor(orgId: string, userId: string, body: {
    url: string
    target_platform?: MultiplierTarget | null
    target_account_id?: string | null
  }): Promise<{ product_id: string; reused: boolean; draft: MultiplierDraft | null; scraped: { title: string; price: number | null; images: number; platform: string; listing_id: string | null } }> {
    if (!body.url?.trim()) throw new BadRequestException('Informe a URL do anúncio do concorrente.')

    const summary = await this.scraping.scrapeFromUrl(body.url.trim(), orgId)
    if (!summary.title?.trim()) {
      throw new BadRequestException('Não consegui ler o anúncio dessa URL (título vazio) — confira o link.')
    }

    // enriquecimento ML: descrição + atributos públicos do item
    let description: string | null = null
    let brand: string | null = null
    let gtin: string | null = null
    if (summary.platform === 'mercadolivre' && summary.listing_id?.startsWith('MLB')) {
      try {
        const { token } = await this.mercadolivre.getTokenForOrg(orgId)
        const [itemRes, descRes] = await Promise.allSettled([
          axios.get<{ attributes?: Array<{ id: string; value_name?: string | null }> }>(
            `https://api.mercadolibre.com/items/${summary.listing_id}?include_attributes=all`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 },
          ),
          axios.get<{ plain_text?: string }>(
            `https://api.mercadolibre.com/items/${summary.listing_id}/description`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 },
          ),
        ])
        if (descRes.status === 'fulfilled') description = descRes.value.data?.plain_text?.trim() || null
        if (itemRes.status === 'fulfilled') {
          const attrs = itemRes.value.data?.attributes ?? []
          const attr = (id: string) => attrs.find(a => a.id === id)?.value_name?.trim() || null
          brand = attr('BRAND')
          gtin  = attr('GTIN')
        }
      } catch (e) {
        this.logger.warn(`[multiplier.import] enriquecimento ML ${summary.listing_id} falhou: ${(e as Error)?.message}`)
      }
    }

    const images = this.normalizeImageUrls(summary.all_images ?? [])
    const price = summary.sale_price ?? summary.price ?? null
    const sku = `IMP-${(summary.listing_id ?? Math.abs(hashCode(body.url))).toString().replace(/[^A-Za-z0-9-]/g, '')}`.slice(0, 40)

    // re-importou a mesma URL? reusa o produto (SKU é único por org)
    const { data: existing } = await supabaseAdmin
      .from('products')
      .select('id')
      .eq('organization_id', orgId)
      .eq('sku', sku)
      .maybeSingle<{ id: string }>()

    let productId: string
    let reused = false
    if (existing) {
      productId = existing.id
      reused = true
    } else {
      const { data: created, error } = await supabaseAdmin
        .from('products')
        .insert({
          organization_id: orgId,
          name:        summary.title.trim().slice(0, 150),
          sku,
          price,
          photo_urls:  images,
          description,
          brand,
          gtin,
          status:      'draft',
        })
        .select('id')
        .single<{ id: string }>()
      if (error) throw new BadRequestException(`importCompetitor: ${error.message}`)
      productId = created.id
      this.logger.log(`[multiplier.import] concorrente ${summary.platform}/${summary.listing_id ?? '—'} → produto ${productId} (${sku})`)
    }

    let draft: MultiplierDraft | null = null
    if (body.target_platform) {
      draft = await this.createDraft(orgId, userId, {
        product_id:        productId,
        target_platform:   body.target_platform,
        target_account_id: body.target_account_id ?? null,
      })
    }

    return {
      product_id: productId,
      reused,
      draft,
      scraped: {
        title: summary.title, price, images: images.length,
        platform: summary.platform, listing_id: summary.listing_id,
      },
    }
  }

  // ── Montagem da proposta ───────────────────────────────────────────────

  private async buildPayload(
    orgId: string,
    target: MultiplierTarget,
    product: ProductRow,
    source: ListingRow | null,
  ): Promise<MultiplierPayload> {
    const key = contentKeyFor(target)
    const channelTitle = key ? product.channel_titles?.[key] : null
    const channelDesc  = key ? product.channel_descriptions?.[key] : null

    const rawTitle =
      channelTitle?.trim() ||
      source?.listing_title?.trim() ||
      product.ml_title?.trim() ||
      product.name?.trim() || ''
    const title = rawTitle.slice(0, CHANNEL_TITLE_LIMITS[target as ChannelPlatform] ?? 255)

    const description =
      channelDesc?.trim() ||
      product.ai_long_description?.trim() ||
      product.description?.trim() ||
      product.ai_short_description?.trim() || null

    const price = source?.listing_price ?? product.price ?? null
    const images = this.collectImageUrls(product).slice(0, 9)

    const dims = (product.length_cm && product.width_cm && product.height_cm)
      ? { length: product.length_cm, width: product.width_cm, height: product.height_cm }
      : null

    const payload: MultiplierPayload = {
      title,
      description,
      price: price != null ? Math.round(Number(price) * 100) / 100 : null,
      image_urls: images,
      sku: product.sku,
      brand: product.brand,
      gtin: product.gtin,
      weight_kg: product.weight_kg,
      package_dimensions_cm: dims,
      stock: product.stock,
    }

    // TikTok: já resolve a categoria recomendada no draft (best-effort) pra
    // revisão humana ver/editar antes do publish.
    if (target === 'tiktok_shop' && title) {
      try {
        const rec = await this.tiktok.recommendCategory(orgId, {
          product_name: title, description: description ?? undefined,
        })
        payload.category_id = rec.category_id
      } catch {
        payload.category_id = null
      }
    }

    // ML: prevê a categoria no draft (domain_discovery, público) e propõe
    // tipo de anúncio (o do produto, ou Clássico) + condição.
    if (target === 'mercadolivre' && title) {
      try {
        const pred = await this.mercadolivre.predictCategory(title)
        payload.category_id = pred.category_id
      } catch {
        payload.category_id = null
      }
      payload.listing_type = this.normalizeMlListingType(product.ml_listing_type)
      payload.condition = 'new'
    }

    return payload
  }

  private publishWarnings(target: MultiplierTarget, p: ProductRow, photos: string[]): string[] {
    const w: string[] = []
    if (photos.length === 0) w.push('sem fotos')
    if (!p.price || p.price <= 0) w.push('sem preço')
    if (target === 'tiktok_shop' && !p.sku?.trim()) w.push('sem SKU (anúncio nasce sem vínculo de estoque)')
    if (target === 'shopee') {
      const desc = p.channel_descriptions?.['shopee'] ?? p.ai_long_description ?? p.description ?? ''
      if ((desc ?? '').trim().length < 20) w.push('descrição curta (<20 chars)')
    }
    if (target === 'mercadolivre') {
      if (!p.brand?.trim()) w.push('sem marca (muitas categorias ML exigem)')
      if (!p.gtin?.trim()) w.push('sem GTIN/EAN')
    }
    return w
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private assertTarget(target: string): asserts target is MultiplierTarget {
    if (!MULTIPLIER_TARGETS.includes(target as MultiplierTarget)) {
      throw new BadRequestException(
        `target_platform inválido: '${target}'. Suportados: ${MULTIPLIER_TARGETS.join(', ')} ` +
        '(Mercado Livre como destino: use o IA Criativo).',
      )
    }
  }

  private async fetchProduct(orgId: string, productId: string): Promise<ProductRow> {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select(PRODUCT_FIELDS)
      .eq('organization_id', orgId)
      .eq('id', productId)
      .maybeSingle()
    if (error) throw new BadRequestException(`fetchProduct: ${error.message}`)
    if (!data) throw new NotFoundException('Produto não encontrado.')
    return data as unknown as ProductRow
  }

  private async fetchDraft(orgId: string, draftId: string): Promise<MultiplierDraft> {
    const { data, error } = await supabaseAdmin
      .from('multiplier_drafts')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', draftId)
      .maybeSingle()
    if (error) throw new BadRequestException(`fetchDraft: ${error.message}`)
    if (!data) throw new NotFoundException('Draft não encontrado.')
    return data as unknown as MultiplierDraft
  }

  private async setDraftStatus(orgId: string, draftId: string, patch: Record<string, unknown>): Promise<void> {
    const { error } = await supabaseAdmin
      .from('multiplier_drafts')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', draftId)
    if (error) throw new BadRequestException(`setDraftStatus: ${error.message}`)
  }

  /** Anúncios ativos da org (opcionalmente de 1 produto), org-scoped via join. */
  private async fetchActiveListings(orgId: string, productId?: string): Promise<ListingRow[]> {
    const out: ListingRow[] = []
    const pageSize = 1000
    for (let from = 0; ; from += pageSize) {
      let qb = supabaseAdmin
        .from('product_listings')
        .select('product_id, platform, account_id, listing_id, listing_title, listing_price, products!inner(organization_id)')
        .eq('products.organization_id', orgId)
        .eq('is_active', true)
        .range(from, from + pageSize - 1)
      if (productId) qb = qb.eq('product_id', productId)
      const { data, error } = await qb
      if (error) throw new BadRequestException(`fetchActiveListings: ${error.message}`)
      const rows = (data ?? []) as unknown as ListingRow[]
      out.push(...rows)
      if (rows.length < pageSize) break
    }
    return out
  }

  /** URLs https de imagem do produto (photo_urls + images jsonb legado). */
  private collectImageUrls(p: ProductRow): string[] {
    const urls: string[] = []
    for (const u of p.photo_urls ?? []) {
      if (typeof u === 'string' && u.startsWith('http')) urls.push(u)
    }
    if (Array.isArray(p.images)) {
      for (const it of p.images as unknown[]) {
        if (typeof it === 'string' && it.startsWith('http')) urls.push(it)
        else if (it && typeof it === 'object') {
          const u = (it as { url?: unknown; secure_url?: unknown }).secure_url ?? (it as { url?: unknown }).url
          if (typeof u === 'string' && u.startsWith('http')) urls.push(u)
        }
      }
    }
    return this.normalizeImageUrls(urls)
  }

  /** Normaliza URLs de imagem pros publicadores: força https e, no CDN do ML,
   *  troca a variante pequena (-O) pela grande (-F) — a Shopee/TikTok rejeitam
   *  ou degradam imagem pequena/http. Aplicado na montagem E no publish
   *  (rascunhos antigos podem ter URL crua). */
  private normalizeImageUrls(urls: Array<string | null | undefined>): string[] {
    const out: string[] = []
    for (const raw of urls ?? []) {
      if (typeof raw !== 'string' || !raw.startsWith('http')) continue
      // placeholder "Processando imagem" do ML não é foto (e 404a no upload)
      if (/mlstatic\.com\/resources\/frontend\/statics\/processing-image/i.test(raw)) continue
      let u = raw.replace(/^http:\/\//, 'https://')
      if (/mlstatic\.com\//.test(u)) u = u.replace(/-O\.(jpg|jpeg|png|webp)$/i, '-F.$1')
      if (!out.includes(u)) out.push(u)
    }
    return out
  }

  /** Fotos pro publish: payload normalizado; se ficar vazio (ex.: origem tinha
   *  só placeholder "processando"), re-coleta FRESCO do produto — as fotos
   *  podem ter terminado de processar depois que o rascunho foi criado. */
  private async resolveImagesForPublish(orgId: string, draft: MultiplierDraft): Promise<string[]> {
    const fromPayload = this.normalizeImageUrls(draft.payload.image_urls)
    if (fromPayload.length > 0) return fromPayload

    try {
      const product = await this.fetchProduct(orgId, draft.product_id)
      const fromProduct = this.collectImageUrls(product).slice(0, 9)
      if (fromProduct.length > 0) return fromProduct
    } catch { /* segue pro fallback do anúncio de origem */ }

    // último recurso: fotos AO VIVO do anúncio ML de origem (o catálogo pode
    // ter sincronizado só o placeholder, mas o anúncio já tem as fotos prontas).
    // ⚠️ multi-conta: usar o token da conta DONA do anúncio (o vínculo sabe);
    // token de outra conta dá 403 no PolicyAgent.
    if (draft.source_platform === 'mercadolivre' && draft.source_listing_id) {
      try {
        const { data: link } = await supabaseAdmin
          .from('product_listings')
          .select('account_id')
          .eq('platform', 'mercadolivre')
          .eq('listing_id', draft.source_listing_id)
          .not('account_id', 'is', null)
          .limit(1)
          .maybeSingle<{ account_id: string | null }>()
        const ownerId = link?.account_id ? Number(link.account_id) : undefined
        const { token } = await this.mercadolivre.getTokenForOrg(
          orgId, Number.isFinite(ownerId) && (ownerId as number) > 0 ? ownerId : undefined,
        )
        const { data } = await axios.get<{ pictures?: Array<{ secure_url?: string; url?: string }> }>(
          `https://api.mercadolibre.com/items/${draft.source_listing_id}?attributes=pictures`,
          { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 },
        )
        const pics = (data?.pictures ?? []).map(p => p.secure_url ?? p.url).filter(Boolean) as string[]
        return this.normalizeImageUrls(pics).slice(0, 9)
      } catch (e) {
        this.logger.warn(`[multiplier] fotos do anúncio origem ${draft.source_listing_id} falharam: ${(e as Error)?.message}`)
      }
    }
    return []
  }
}

/** Hash simples e estável pra gerar SKU de import quando a URL não tem id. */
function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0 }
  return h
}
