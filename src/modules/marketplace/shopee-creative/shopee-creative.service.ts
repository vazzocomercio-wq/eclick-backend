import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { ShopeeAlgoScoreService } from '../shopee-algo-score/shopee-algo-score.service'
import { AlgoScoreInput } from '../shopee-algo-score/algo-score.types'
import { MarketplaceService } from '../marketplace.service'
import { ShopeeAdapter } from '../adapters/shopee.adapter'
import { ShopeeProductSyncService } from '../shopee-sync/shopee-product-sync.service'
import {
  ShopeeDraftListing, ShopeeEvaluateResponse, RELEVANCE_GATE,
} from './shopee-creative.types'

/** F18 F1.7 + Fase F — IA Criativo Shopee: guard de pré-publicação + publish.
 *
 *  evaluateDraft() — guard puro: roda o Algorithm Score (F1.1) no rascunho e
 *  decide se libera publish (relevância >= gate). Sem I/O.
 *
 *  publish() (Fase F) — esteira real: gate → upload imagens (image_id) →
 *  categoria recomendada → atributos obrigatórios → logística → add_item →
 *  grava em product_listings platform='shopee'. ⚠️ cria anúncio REAL (review
 *  Shopee). Suporta dry-run (só monta o payload) e delete_after (teste). */
@Injectable()
export class ShopeeCreativePublisherService {
  private readonly logger = new Logger(ShopeeCreativePublisherService.name)

  constructor(
    private readonly algoScore:   ShopeeAlgoScoreService,
    private readonly mp:          MarketplaceService,
    private readonly productSync: ShopeeProductSyncService,
  ) {}

  /** Avalia rascunho em dry-run. Performance/qualidade de loja entram
   *  neutros (rascunho não tem vendas nem é shop-level), então só
   *  relevância + preço/marketing são acionáveis. */
  evaluateDraft(draft: ShopeeDraftListing): ShopeeEvaluateResponse {
    const input: AlgoScoreInput = {
      shop_id:               draft.shop_id,
      item_id:               draft.item_id ?? 0,
      product_id:            draft.product_id ?? null,
      title:                 draft.title,
      description:           draft.description,
      image_count:           draft.image_count,
      image_min_dimension:   draft.image_min_dimension,
      attrs_filled:          draft.attrs_filled,
      attrs_mandatory_total: draft.attrs_mandatory_total,
      price:                 draft.price,
      market_median_price:   draft.market_median_price,
      // Performance + shop quality ausentes de propósito — rascunho.
      // O algo score trata null como neutro (não pune).
    }

    const score = this.algoScore.compute(input)

    const blockers: string[] = []
    const warnings: string[] = []

    // Gate principal: relevância.
    if (score.pillars.relevance < RELEVANCE_GATE) {
      blockers.push(
        `Relevância ${score.pillars.relevance}/100 abaixo do mínimo (${RELEVANCE_GATE}). ` +
        `Corrija título/atributos/imagens/descrição antes de publicar — ` +
        `Shopee ranqueia anúncios completos muito melhor.`,
      )
    }

    // Warnings não-bloqueantes: issues de severity alta dos outros pilares.
    for (const iss of score.issues) {
      if (iss.severity === 'high' && iss.pillar !== 'relevance') {
        warnings.push(`${iss.description} → ${iss.recommended_action}`)
      }
    }

    const ready = blockers.length === 0

    return {
      score,
      ready,
      blockers,
      warnings,
      publish_enabled: this.isPublishEnabled(),
    }
  }

  /** F18 Fase F — Publica de fato no Shopee (esteira IA Criativo → add_item).
   *  Monta o anúncio a partir do rascunho + dados do produto do catálogo
   *  (peso/dimensão/fotos/descrição/marca). Sobe imagens, recomenda categoria,
   *  preenche atributos obrigatórios (best-effort), resolve logística e cria via
   *  add_item. ⚠️ cria anúncio REAL (entra em review da Shopee).
   *
   *  opts.dryRun → só monta e devolve o payload (não cria). opts.deleteAfter →
   *  cria e deleta logo em seguida (validação ao vivo sem deixar lixo). */
  async publish(orgId: string, draft: ShopeeDraftListing, opts?: { dryRun?: boolean; deleteAfter?: boolean }): Promise<{
    ok: boolean
    item_id?: number
    category_id?: number | null
    images?: number
    dry_run?: boolean
    deleted?: boolean
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload?: Record<string, any>
    blockers?: string[]
  }> {
    if (!this.isPublishEnabled()) {
      throw new BadRequestException('Publicação Shopee desabilitada (credenciais Open Platform ausentes).')
    }
    // Fonte do conteúdo: catálogo (product_id) OU direto do AI Criativo
    // (image_urls + título/desc/preço no draft). Sem nenhum dos dois, nada a publicar.
    const fromCatalog = !!draft.product_id
    if (!fromCatalog && !(draft.image_urls && draft.image_urls.length)) {
      throw new BadRequestException('Informe product_id (catálogo) ou image_urls (AI Criativo) para publicar.')
    }

    // 1) gate de relevância (mesmo do evaluateDraft)
    const evalRes = this.evaluateDraft(draft)
    if (!evalRes.ready) return { ok: false, blockers: evalRes.blockers }

    // 2) produto do catálogo (org-scoped) — OPCIONAL no fluxo AI Criativo
    type ProdRow = {
      id: string; name: string | null; description: string | null; ai_long_description: string | null
      brand: string | null; weight_kg: number | null; width_cm: number | null; length_cm: number | null
      height_cm: number | null; photo_urls: unknown; images: unknown; price: number | null; sku: string | null
    }
    let prod: ProdRow | null = null
    if (fromCatalog) {
      const { data, error: pErr } = await supabaseAdmin
        .from('products')
        .select('id, name, description, ai_long_description, brand, weight_kg, width_cm, length_cm, height_cm, photo_urls, images, price, sku')
        .eq('id', draft.product_id as string)
        .eq('organization_id', orgId)
        .maybeSingle()
      if (pErr) throw new Error(`products: ${pErr.message}`)
      if (!data) throw new BadRequestException('Produto não encontrado nesta organização')
      prod = data as unknown as ProdRow
    }

    // 3) conn Shopee + token fresco
    const resolved = await this.mp.resolve(orgId, 'shopee')
    if (!resolved?.conn?.shop_id) throw new NotFoundException('Loja Shopee não conectada nesta organização')
    const conn = await this.productSync.ensureFreshToken(resolved.conn)
    const adapter = resolved.adapter as ShopeeAdapter

    const name = (draft.title ?? prod?.name ?? '').toString().trim()
    if (!name) throw new BadRequestException('Título obrigatório')
    const description = (draft.description ?? prod?.ai_long_description ?? prod?.description ?? '').toString().trim()
    if (description.length < 20) throw new BadRequestException('Descrição muito curta (mín. 20 caracteres na Shopee)')

    // 4) categoria (do rascunho ou recomendada pelo nome)
    const categoryId = await this.step('categoria (category_recommend)', () => adapter.recommendCategory(conn, name))
    if (!categoryId) throw new BadRequestException('Não foi possível recomendar uma categoria Shopee para este produto. Informe a categoria manualmente.')

    // 5) imagens: image_urls (AI Criativo) OU photo_urls/images (catálogo) → upload → image_id (máx 9)
    const rawPhotos: unknown[] =
      draft.image_urls && draft.image_urls.length
        ? draft.image_urls
        : Array.isArray(prod?.photo_urls)
          ? (prod!.photo_urls as unknown[])
          : Array.isArray(prod?.images)
            ? (prod!.images as unknown[])
            : []
    const photoUrls: string[] = rawPhotos
      .map((x: unknown) => (typeof x === 'string' ? x : (x as { url?: string })?.url))
      .filter((u: unknown): u is string => typeof u === 'string' && u.startsWith('http'))
      .slice(0, 9)
    if (!photoUrls.length) throw new BadRequestException('Sem fotos (https) para publicar.')
    const imageIds: string[] = []
    let uploadErr: string | null = null
    for (const u of photoUrls) {
      try { imageIds.push(await adapter.uploadImage(conn, u)) }
      catch (e) { uploadErr = (e as Error)?.message ?? null; this.logger.warn(`[shopee.publish] upload falhou ${u}: ${uploadErr}`) }
    }
    if (!imageIds.length) {
      throw new BadRequestException(this.scopeMsg('upload de imagem (media_space)', uploadErr) ?? 'Falha ao subir as imagens pro media space da Shopee.')
    }

    // 6) atributos obrigatórios (best-effort: marca + enums com 1ª opção).
    // NÃO-FATAL: se get_attribute_tree falhar, segue sem atributos — o add_item
    // dirá exatamente quais mandatórios faltam (em vez de travar tudo aqui).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let attributeList: any[] = []
    try {
      const attrRaw = await adapter.getCategoryAttributes(conn, categoryId)
      attributeList = this.buildMandatoryAttributes(attrRaw)
    } catch (e) {
      this.logger.warn(`[shopee.publish] atributos (get_attribute_tree) falhou — segue sem: ${(e as Error)?.message}`)
    }

    // 7) logística: canais habilitados
    const channels = await this.step('logística (get_channel_list)', () => adapter.getLogisticsChannels(conn))
    const enabled = channels.filter(c => c.enabled && Number.isFinite(c.channel_id))
    if (!enabled.length) throw new BadRequestException('Nenhum canal de logística habilitado na loja Shopee.')
    const logisticInfo = enabled.map(c => ({ logistic_id: c.channel_id, enabled: true }))

    // 8) preço/estoque/peso/dimensão (draft tem prioridade; catálogo/defaults completam)
    const price = Number(draft.price ?? prod?.price ?? 0)
    if (!(price > 0)) throw new BadRequestException('Preço inválido')
    const weightSrc = Number(draft.weight_kg ?? prod?.weight_kg)
    const weight = weightSrc > 0 ? weightSrc : 0.5 // kg (default leve)
    const dimension = {
      package_length: Math.max(1, Math.round(Number(draft.package_length_cm ?? prod?.length_cm) || 20)),
      package_width:  Math.max(1, Math.round(Number(draft.package_width_cm  ?? prod?.width_cm)  || 20)),
      package_height: Math.max(1, Math.round(Number(draft.package_height_cm ?? prod?.height_cm) || 10)),
    }
    const brandName = (draft.brand ?? prod?.brand ?? 'No Brand').toString().slice(0, 60)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: Record<string, any> = {
      original_price: price,
      description,
      weight,
      item_name: name.slice(0, 255),
      category_id: categoryId,
      image: { image_id_list: imageIds },
      logistic_info: logisticInfo,
      attribute_list: attributeList,
      dimension,
      normal_stock: 0, // estoque entra depois via update_stock (Fase C, real+virtual)
      brand: { brand_id: 0, original_brand_name: brandName },
      item_status: 'NORMAL',
      seller_stock: [{ stock: 0 }],
    }

    if (opts?.dryRun) {
      return { ok: true, dry_run: true, category_id: categoryId, images: imageIds.length, payload }
    }

    // 9) cria o anúncio
    const { item_id } = await this.step('criar anúncio (add_item)', () => adapter.addItem(conn, payload))

    // teste ao vivo: cria e remove (não deixa lixo no catálogo Shopee)
    if (opts?.deleteAfter) {
      try { await adapter.deleteItem(conn, item_id) }
      catch (e) { this.logger.warn(`[shopee.publish] deleteAfter falhou item=${item_id}: ${(e as Error)?.message}`) }
      return { ok: true, item_id, category_id: categoryId, images: imageIds.length, deleted: true }
    }

    // 10) grava vínculo anúncio↔produto (mesmo padrão da Fase A). Só quando há
    // produto de catálogo — no fluxo AI Criativo não há row em `products`.
    if (prod) {
      await supabaseAdmin.from('product_listings').upsert({
        platform:      'shopee',
        account_id:    String(conn.shop_id),
        listing_id:    String(item_id),
        variation_id:  '',
        product_id:    prod.id,
        listing_title: name,
        listing_price: price,
        is_active:     true,
      }, { onConflict: 'platform,account_id,listing_id,variation_id,product_id' })
    }

    this.logger.log(`[shopee.publish] org=${orgId} product=${prod?.id ?? '(criativo)'} → item=${item_id} cat=${categoryId} imgs=${imageIds.length}`)
    return { ok: true, item_id, category_id: categoryId, images: imageIds.length }
  }

  /** Executa um passo da esteira convertendo erro 403/Forbidden da Shopee numa
   *  mensagem ACIONÁVEL (= escopo de API não autorizado no app, ação do user no
   *  Open Platform Console + re-OAuth), igual o bloqueio do módulo Ads. */
  private async step<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e: unknown) {
      const msg = this.scopeMsg(label, (e as Error)?.message ?? null, e)
      if (msg) throw new BadRequestException(msg)
      // Erro de negócio da Shopee (ex.: atributo obrigatório no add_item) →
      // 400 acionável em vez de 500 cru, com o passo e a mensagem da Shopee.
      throw new BadRequestException(`${label}: ${(e as Error)?.message ?? 'falhou'}`)
    }
  }

  /** Monta mensagem de escopo se o erro for 403/Forbidden; senão null. */
  private scopeMsg(label: string, message: string | null, raw?: unknown): string | null {
    const status = axios.isAxiosError(raw) ? raw.response?.status : undefined
    const is403 = status === 403 || /403|forbidden|no permission|not authorized/i.test(message ?? '')
    if (!is403) return null
    return `Shopee bloqueou "${label}" com 403 (Forbidden) — o app e-Click não tem esse escopo de API ` +
      `autorizado pra publicação. É autorização no Open Platform Console (habilitar o módulo de ` +
      `gestão de produtos/logística + re-OAuth da loja) — ação no painel Shopee, não no código. ` +
      `(igual ao destravamento do módulo Ads).`
  }

  /** Best-effort dos atributos OBRIGATÓRIOS de uma categoria: pra cada
   *  mandatório com lista de valores, pega a 1ª opção; texto/numérico livre é
   *  pulado (pode bloquear o add_item — a Shopee dirá qual falta). Shape de
   *  saída = o que o add_item espera em attribute_list. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildMandatoryAttributes(attrRaw: any): any[] {
    // get_attribute_tree vem aninhado ({ list: [{ attribute_tree: [...] }] } ou
    // { list: [...attrs] }); o legado get_attributes vinha flat (attribute_list/
    // attributes). Achata recursivamente até os nós que têm attribute_id.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collect = (node: any): any[] => {
      if (!node) return []
      if (Array.isArray(node)) return node.flatMap(collect)
      if (node.attribute_id != null) return [node]
      return collect(node.attribute_tree ?? node.attribute_list ?? node.attributes ?? node.list ?? node.children ?? [])
    }
    const list = collect(attrRaw)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any[] = []
    for (const a of list as any[]) {
      const mandatory = a?.is_mandatory ?? a?.mandatory ?? false
      if (!mandatory) continue
      const attrId = a?.attribute_id
      const values = a?.attribute_value_list ?? a?.value_list ?? []
      if (attrId != null && Array.isArray(values) && values.length) {
        const v = values[0]
        out.push({
          attribute_id: Number(attrId),
          attribute_value_list: [{
            value_id: Number(v?.value_id ?? 0),
            original_value_name: v?.original_value_name ?? v?.display_value_name ?? v?.value_name ?? '',
          }],
        })
      }
    }
    return out
  }

  /** Feature flag: só libera publish quando creds Shopee de prod estiverem
   *  setadas (já estão em prod). */
  private isPublishEnabled(): boolean {
    return Boolean(process.env.SHOPEE_PARTNER_ID && process.env.SHOPEE_PARTNER_KEY)
  }
}
