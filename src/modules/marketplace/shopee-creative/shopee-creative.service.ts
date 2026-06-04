import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import { randomUUID } from 'crypto'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { composeListingDescription } from '../../../common/listing-description'
import { ShopeeAlgoScoreService } from '../shopee-algo-score/shopee-algo-score.service'
import { AlgoScoreInput } from '../shopee-algo-score/algo-score.types'
import { MarketplaceService } from '../marketplace.service'
import { ShopeeAdapter } from '../adapters/shopee.adapter'
import { ShopeeProductSyncService } from '../shopee-sync/shopee-product-sync.service'
import { ShopeeStockSyncService } from '../shopee-sync/shopee-stock-sync.service'
import {
  ShopeeDraftListing, ShopeeEvaluateResponse, RELEVANCE_GATE,
} from './shopee-creative.types'

/** item_status cru da Shopee → vocabulário comum do painel de publicações.
 *  NORMAL = no ar; UNLIST = despublicado pelo vendedor; BANNED/DELETED =
 *  removido; REVIEWING = em análise. */
function normalizeShopeeStatus(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.toUpperCase()
  if (s === 'NORMAL') return 'active'
  if (s === 'UNLIST') return 'paused'
  if (s === 'REVIEWING' || s === 'REVIEW') return 'under_review'
  if (s === 'BANNED') return 'inactive'
  if (s === 'DELETED' || s.includes('DELETE')) return 'closed'
  return 'inactive'
}

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
    private readonly stockSync:   ShopeeStockSyncService,
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
    /** estoque virtual (físico+virtual) aplicado no anúncio pós-publish (regra
     *  Vazzo). undefined quando não há produto de catálogo/estoque vinculado. */
    virtual_stock?: number
    stock_paused?: boolean
    attributes_count?: number
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
    // Shopee não tem campo de destaques/FAQ → junta tudo na descrição (a
    // descrição editável do anúncio fica limpa; a composição é só aqui).
    const baseDescription = (draft.description ?? prod?.ai_long_description ?? prod?.description ?? '').toString().trim()
    const description = composeListingDescription(baseDescription, draft.bullets, draft.faq)
    if (baseDescription.length < 20) throw new BadRequestException('Descrição muito curta (mín. 20 caracteres na Shopee)')

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

    // 6) atributos obrigatórios. Mapeia os atributos do IA Criativo (marca,
    // tensão, potência, cor, material) pros campos da categoria Shopee (de-para
    // por nome+valor, igual o publish do TikTok). Onde não há atributo do IA,
    // cai pra 1ª opção (dropdown) ou pro nome do produto (free-text), pra não
    // travar. NÃO-FATAL: se get_attribute_tree falhar, segue sem.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let attributeList: any[] = []      // obrigatórios + opcionais (enriquecido)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mandatoryList: any[] = []      // só obrigatórios (fallback do retry)
    let attrNeedsInput: Array<{ attribute_id: number; name: string }> = []
    try {
      const attrRaw = await adapter.getCategoryAttributes(conn, categoryId)
      const built = this.buildMandatoryAttributes(attrRaw, draft.ml_attributes ?? [], {
        fallbackText: name,
        regNumber: draft.registration_number ?? undefined,
        notApplicable: draft.registration_not_applicable ?? false,
      })
      attributeList = built.list
      mandatoryList = built.mandatoryList
      attrNeedsInput = built.needsInput
    } catch (e) {
      this.logger.warn(`[shopee.publish] atributos (get_attribute_tree) falhou — segue sem: ${(e as Error)?.message}`)
    }
    // Campo numérico obrigatório (ex.: Registration ID / nº Inmetro) sem valor:
    // bloqueia com mensagem acionável em vez de mandar texto e tomar 400
    // "Invalid Registration ID. Please provide a valid number.".
    if (attrNeedsInput.length) {
      const nomes = attrNeedsInput.map((a) => `"${a.name}"`).join(', ')
      return {
        ok: false,
        blockers: [
          `A categoria Shopee exige ${attrNeedsInput.length === 1 ? 'o campo numérico' : 'os campos numéricos'} ${nomes} ` +
          `(número de registro, ex.: Inmetro). Preencha o campo "Número de registro" — ou marque ` +
          `"não se aplica / não tenho" — e publique de novo.`,
        ],
      }
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

    // 9) cria o anúncio. Tenta com enriquecimento (obrigatórios + opcionais); se
    // a Shopee rejeitar (provável atributo opcional), refaz só com os
    // obrigatórios — nunca quebra um publish que funcionaria. this.step converte
    // o erro final (403/escopo ou negócio) em 400 acionável.
    const { item_id } = await this.step('criar anúncio (add_item)', async () => {
      try {
        return await adapter.addItem(conn, payload)
      } catch (e) {
        if (mandatoryList.length >= attributeList.length) throw e // não havia opcionais
        this.logger.warn(`[shopee.publish] add_item falhou com opcionais — retry só obrigatórios: ${(e as Error)?.message}`)
        return await adapter.addItem(conn, { ...payload, attribute_list: mandatoryList })
      }
    })

    // teste ao vivo: cria e remove (não deixa lixo no catálogo Shopee)
    if (opts?.deleteAfter) {
      try { await adapter.deleteItem(conn, item_id) }
      catch (e) { this.logger.warn(`[shopee.publish] deleteAfter falhou item=${item_id}: ${(e as Error)?.message}`) }
      return { ok: true, item_id, category_id: categoryId, images: imageIds.length, deleted: true }
    }

    // 10) vínculo anúncio↔produto de catálogo (`products.id`). Vem do fluxo
    // catálogo (prod) OU do AI Criativo via product_id/SKU resolvido no front
    // (draft.catalog_product_id). Sem catálogo (anúncio standalone) → não há
    // estoque/ledger a vincular.
    const catalogProductId = prod?.id ?? (draft.catalog_product_id ? String(draft.catalog_product_id) : null)
    let virtualStock: number | undefined
    let stockPaused: boolean | undefined
    if (catalogProductId) {
      await supabaseAdmin.from('product_listings').upsert({
        platform:      'shopee',
        account_id:    String(conn.shop_id),
        listing_id:    String(item_id),
        variation_id:  '',
        product_id:    catalogProductId,
        listing_title: name,
        listing_price: price,
        is_active:     true,
      }, { onConflict: 'platform,account_id,listing_id,variation_id,product_id' })

      // 11) ESTOQUE VIRTUAL (regra Vazzo): aplica físico+virtual e respeita o
      // mínimo p/ pausar — reusa o motor operacional (resolve location BRZ, loga
      // em stock_sync_logs). bypassGate = ação explícita do user (publish). Sem
      // registro de estoque (produto fora do catálogo) → pula, anúncio fica 0.
      try {
        const r = await this.stockSync.pushStockForProduct(catalogProductId, { bypassGate: true })
        virtualStock = r.virtual_stock
        stockPaused = r.paused
        this.logger.log(`[shopee.publish] estoque virtual product=${catalogProductId} item=${item_id} virtual=${r.virtual_stock ?? '—'} paused=${r.paused ?? '—'} skipped=${r.skipped ?? ''}`)
      } catch (e) {
        this.logger.warn(`[shopee.publish] push estoque virtual falhou item=${item_id}: ${(e as Error)?.message}`)
      }
    }

    // Registra a publicação em creative_publications pra aparecer na lista
    // "PUBLICAÇÕES DESSE ANÚNCIO" junto com o ML (NÃO-FATAL). Precisa do listing
    // + creative_product (FKs) que o front manda. external_url = link da loja.
    if (draft.listing_id && draft.creative_product_id) {
      try {
        await supabaseAdmin.from('creative_publications').insert({
          organization_id: orgId,
          listing_id:      draft.listing_id,
          product_id:      draft.creative_product_id,
          marketplace:     'shopee',
          status:          'published',
          idempotency_key: randomUUID(),
          price:           price > 0 ? price : null,
          external_id:     String(item_id),
          external_url:    `https://shopee.com.br/product/${conn.shop_id}/${item_id}`,
          published_at:    new Date().toISOString(),
        })
      } catch (e) {
        this.logger.warn(`[shopee.publish] registro creative_publications falhou item=${item_id}: ${(e as Error)?.message}`)
      }
    }

    this.logger.log(`[shopee.publish] org=${orgId} product=${catalogProductId ?? '(criativo)'} → item=${item_id} cat=${categoryId} imgs=${imageIds.length} attrs=${attributeList.length}`)
    return {
      ok: true, item_id, category_id: categoryId, images: imageIds.length,
      virtual_stock: virtualStock, stock_paused: stockPaused, attributes_count: attributeList.length,
    }
  }

  /** Sync de confirmação — busca o status atual do anúncio na Shopee e o
   *  normaliza pro vocabulário comum do painel de publicações
   *  (active/paused/closed/under_review/inactive). Usado pela esteira IA
   *  Criativo (botão "sync" + worker). Resolve conn + token fresco como no
   *  publish. Lança se a loja não estiver conectada (o caller faz soft-fallback). */
  async syncListingStatus(orgId: string, itemId: string | number): Promise<{ raw: string | null; normalized: string | null }> {
    const resolved = await this.mp.resolve(orgId, 'shopee')
    if (!resolved?.conn?.shop_id) throw new NotFoundException('Loja Shopee não conectada nesta organização')
    const conn = await this.productSync.ensureFreshToken(resolved.conn)
    const adapter = resolved.adapter as ShopeeAdapter
    const raw = await adapter.getItemStatus(conn, itemId)
    return { raw, normalized: normalizeShopeeStatus(raw) }
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

  /** normaliza p/ comparar nomes (lower + sem acento). */
  private norm(s?: string): string {
    return (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
  }

  /** De-para: id de atributo do IA Criativo (formato ML) → palavras-chave do
   *  nome do atributo na Shopee. Mesma ideia do ML_TO_TT_ATTR do TikTok. */
  private static readonly ML_TO_SHOPEE_ATTR: Record<string, string[]> = {
    BRAND: ['marca', 'brand'],
    VOLTAGE: ['tensao', 'voltagem', 'voltage'],
    POWER: ['potencia', 'power', 'watt'],
    MATERIALS: ['material'],
    STRUCTURE_MATERIAL: ['material'],
    SCREEN_MATERIAL: ['material'],
    COLOR: ['cor', 'color', 'colour'],
    MAIN_COLOR: ['cor', 'color', 'colour'],
    STRUCTURE_COLOR: ['cor', 'color', 'colour'],
    SCREEN_COLOR: ['light colour', 'light color', 'cor da luz'],
    MODEL: ['model', 'modelo'],
    PIECES_NUMBER: ['quantity', 'quantidade', 'pieces', 'unidades', 'qty'],
    LIGHTING_TECHNOLOGY: ['light bulb type', 'bulb type', 'tipo de lampada', 'lighting type'],
    FITTING_TYPES: ['fitting', 'soquete', 'base', 'bocal'],
    WITH_BATTERY: ['battery', 'bateria', 'pilha'],
    ENERGY_EFFICIENCY: ['energy', 'eficiencia', 'energetica'],
  }

  /** Monta o attribute_list do add_item a partir da árvore da categoria Shopee.
   *  Pra cada OBRIGATÓRIO: mapeia o valor dos atributos do IA Criativo (de-para
   *  por nome + match de valor, igual o publish do TikTok). Onde não há atributo
   *  do IA: dropdown → 1ª opção; free-text de TEXTO → nome do produto; free-text
   *  NUMÉRICO (ex.: "Registration ID"/Inmetro) → número de registro informado
   *  pelo usuário. Campo numérico obrigatório sem valor cai em `needsInput` — o
   *  publish bloqueia com mensagem acionável em vez de mandar texto e tomar 400
   *  ("provide a valid number"). Filhos condicionais do valor escolhido também
   *  são preenchidos. O usuário revisa/ajusta no Seller Center depois. */
  private buildMandatoryAttributes(
    attrRaw: unknown,
    mlAttributes: Array<{ id: string; value_name?: string; value_id?: string }> = [],
    opts: { fallbackText?: string; regNumber?: string; notApplicable?: boolean } = {},
  ): {
    list: Array<{ attribute_id: number; attribute_value_list: Array<{ value_id: number; original_value_name: string }> }>
    mandatoryList: Array<{ attribute_id: number; attribute_value_list: Array<{ value_id: number; original_value_name: string }> }>
    needsInput: Array<{ attribute_id: number; name: string }>
  } {
    const fallbackText = opts.fallbackText ?? ''
    const regDigits = (opts.regNumber ?? '').replace(/\D/g, '')
    // "não se aplica" (espelho do value_id -1 do ML): em dropdowns de
    // certificação/registro escolhe a opção de isento/não-aplicável; em campo
    // numérico obrigatório manda 0 como sentinela em vez de bloquear.
    const notApplicable = opts.notApplicable ?? false
    const REG_ATTR = /(inmetro|certif|registr|registration|anatel|homolog|licen)/
    // valores de "isento/não-aplicável" (dados Shopee vêm em inglês: "N/A – NBR
    // not applicable", "None", "Not certified"…). PT + EN.
    const NA_VALUE = /(nao aplic|not applic|n\/?a\b|isento|isenc|exempt|sem registro|nao possu|nao certif|not certif|nenhum|none)/
    const mls = (mlAttributes ?? []).filter((m) => m.value_name && m.value_id !== '-1')
    const findMl = (shopeeName: string) => {
      const sn = this.norm(shopeeName)
      for (const ml of mls) {
        const kws = ShopeeCreativePublisherService.ML_TO_SHOPEE_ATTR[ml.id] ?? [this.norm(ml.id)]
        if (kws.some((kw) => sn.includes(this.norm(kw)))) return ml
      }
      return null
    }
    const list: Array<{ attribute_id: number; attribute_value_list: Array<{ value_id: number; original_value_name: string }> }> = []
    const needsInput: Array<{ attribute_id: number; name: string }> = []
    const seen = new Set<number>()
    const optionalIds = new Set<number>() // atributos OPCIONAIS preenchidos (enriquecimento)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vname = (x: any): string => x?.original_value_name ?? x?.name ?? x?.value_name ?? ''
    const push = (attrId: number, valueId: number, valueName: string, optional = false) => {
      list.push({ attribute_id: attrId, attribute_value_list: [{ value_id: valueId, original_value_name: (valueName ?? '').slice(0, 100) }] })
      if (optional) optionalIds.add(attrId)
    }
    // ── custo de uma opção de dropdown ──────────────────────────────────────
    // = nº de campos OBRIGATÓRIOS free-text (sem lista de valores, ex.:
    // "Registration ID"/"Model Name") que essa opção destrava nos filhos
    // condicionais. Dropdown filho escolhe seu próprio valor mais barato. Assim
    // o parser evita "Connection Type=Wireless" (que torna Registration ID
    // obrigatório) e prefere "Others" (custo 0) — mais barato E correto p/ uma
    // luminária. Free-text obrigatório = custo 1 (precisa de dado que não temos).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const valsOf = (a: any): any[] => a?.attribute_value_list ?? a?.value_list ?? []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isMand = (a: any): boolean => Boolean(a?.mandatory ?? a?.is_mandatory ?? false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const costValue = (val: any, depth: number): number => {
      if (!val || depth > 8) return 0
      let c = 0
      for (const child of (val.child_attribute_list ?? [])) c += costAttr(child, depth + 1)
      return c
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const costAttr = (attr: any, depth: number): number => {
      if (!attr || depth > 8 || !isMand(attr)) return 0
      const cv = valsOf(attr)
      if (!Array.isArray(cv) || !cv.length) return 1 // free-text obrigatório
      let min = Infinity
      for (const val of cv) min = Math.min(min, costValue(val, depth + 1))
      return min === Infinity ? 0 : min
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fill = (attr: any, depth: number): void => {
      if (!attr || depth > 6) return
      const attrId = Number(attr.attribute_id)
      if (!Number.isFinite(attrId) || seen.has(attrId)) return
      const mandatory = Boolean(attr.mandatory ?? attr.is_mandatory ?? false)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const values: any[] = attr.attribute_value_list ?? attr.value_list ?? []
      const attrName = String(attr.name ?? attr.original_attribute_name ?? '')
      const ml = findMl(attrName)

      // OPCIONAL: enriquece SÓ quando há dado do IA Criativo que casa — sem dado
      // deixa em branco (preencher opcional com 1ª opção = lixo). Mais atributos
      // preenchidos = melhor ranking/qualidade na Shopee. Marcado optional=true
      // pro publish poder refazer só com obrigatórios se a Shopee rejeitar.
      if (!mandatory) {
        if (!ml?.value_name) return
        seen.add(attrId)
        if (Array.isArray(values) && values.length) {
          const mlv = this.norm(ml.value_name)
          const m = values.find((x) => this.norm(vname(x)) === mlv)
            ?? values.find((x) => { const n = this.norm(vname(x)); return n !== '' && (n.includes(mlv) || mlv.includes(n)) })
          if (m) {
            push(attrId, Number(m.value_id ?? 0), vname(m), true)
            for (const child of (m.child_attribute_list ?? [])) fill(child, depth + 1)
          }
          // dropdown opcional sem valor casado → não força (deixa vazio)
        } else {
          push(attrId, 0, ml.value_name, true) // free-text opcional
        }
        return
      }

      seen.add(attrId)
      if (Array.isArray(values) && values.length) {
        // dropdown OBRIGATÓRIO: casa o valor do IA Criativo; senão menor custo.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let v: any = undefined
        if (ml?.value_name) {
          const mlv = this.norm(ml.value_name)
          v = values.find((x) => this.norm(vname(x)) === mlv)
            ?? values.find((x) => { const n = this.norm(vname(x)); return n !== '' && (n.includes(mlv) || mlv.includes(n)) })
        }
        if (!v) {
          // sem match do IA Criativo: escolhe a opção que destrava MENOS campos
          // obrigatórios free-text (evita Wireless→Registration ID; prefere
          // Others, custo 0). Empate → opção de isento/não-aplicável só quando
          // o user marcou "não se aplica" (senão a 1ª, p/ não mislabel).
          let min = Infinity
          for (const cand of values) { const c = costValue(cand, depth); if (c < min) min = c }
          const cheapest = values.filter((cand) => costValue(cand, depth) === min)
          if (notApplicable && REG_ATTR.test(this.norm(attrName))) {
            v = cheapest.find((x) => NA_VALUE.test(this.norm(vname(x))))
          }
          v = v ?? cheapest[0] ?? values[0]
        }
        push(attrId, Number(v?.value_id ?? 0), vname(v))
        for (const child of (v?.child_attribute_list ?? [])) fill(child, depth + 1)
        return
      }
      // free-text obrigatório (sem lista de valores): texto vs numérico.
      const ivt = String(attr.input_validation_type ?? attr.input_type ?? attr.format_type ?? '').toUpperCase()
      const numeric = /INT|FLOAT|NUMBER|NUMERIC|QUANTITATIVE/.test(ivt)
        || /(registration|registro|\bid\b|numero|number|cpf|cnpj|codigo|ncm|gtin|ean|barcode|phone|telefone)/.test(this.norm(attrName))
      const mlVal = ml?.value_name?.trim()
      if (numeric) {
        const mlDigits = (mlVal ?? '').replace(/\D/g, '')
        const val = regDigits || mlDigits // ambos só dígitos
        if (val) push(attrId, 0, val)
        else if (notApplicable) push(attrId, 0, '0') // sentinela "não se aplica"
        else needsInput.push({ attribute_id: attrId, name: attrName || `atributo ${attrId}` })
      } else {
        push(attrId, 0, mlVal || fallbackText || 'N/A')
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodes: any[] = Array.isArray((attrRaw as any)?.list) ? (attrRaw as any).list : Array.isArray(attrRaw) ? (attrRaw as any[]) : [attrRaw]
    for (const node of nodes) {
      const tree = node?.attribute_tree ?? node?.attribute_list ?? node?.attributes ?? (node?.attribute_id != null ? [node] : [])
      for (const a of (Array.isArray(tree) ? tree : [])) fill(a, 0)
    }
    return { list, mandatoryList: list.filter((x) => !optionalIds.has(x.attribute_id)), needsInput }
  }

  /** Feature flag: só libera publish quando creds Shopee de prod estiverem
   *  setadas (já estão em prod). */
  private isPublishEnabled(): boolean {
    return Boolean(process.env.SHOPEE_PARTNER_ID && process.env.SHOPEE_PARTNER_KEY)
  }
}
