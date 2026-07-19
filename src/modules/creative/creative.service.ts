import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import { CategoryResearchService } from '../e-otimizer/services/category-research.service'
import {
  PRODUCT_ANALYSIS_PROMPT,
  buildListingPrompt,
  buildVariantPrompt,
  buildImagePromptsRequest,
  buildVideoPromptsRequest,
  type ListingPromptInput,
} from './creative.prompts'
import type { Provider } from '../ai/defaults'
import { getMarketplaceRules, type Marketplace } from './creative.marketplace-rules'
import { resolveAdjustment, type CostAdjustment, type CostAdjustmentType } from '../icarus-integration/supplier-cost.util'

// ── Types refletindo o schema ─────────────────────────────────────────────

export interface CreativeProduct {
  id:                       string
  organization_id:          string
  user_id:                  string | null
  name:                     string
  category:                 string
  brand:                    string | null
  main_image_url:           string
  main_image_storage_path:  string
  dimensions:               Record<string, unknown>
  color:                    string | null
  material:                 string | null
  differentials:            string[]
  target_audience:          string | null
  sku:                      string | null
  ean:                      string | null
  ai_analysis:              Record<string, unknown>
  reference_images:         string[]
  competitor_links:         string[]
  reference_video_url:      string | null
  brand_identity_url:       string | null
  status:                   'draft' | 'analyzing' | 'ready' | 'archived'
  /** Onda 1 M1 — vínculo opcional com catálogo mestre `products` */
  product_id:               string | null
  created_at:               string
  updated_at:               string
}

export interface CreativeBriefing {
  id:                  string
  product_id:          string
  organization_id:     string
  target_marketplace:  Marketplace
  visual_style:        string
  /** @deprecated use environments[] */
  environment:         string | null
  environments:        string[]
  custom_environment:  string | null
  custom_prompt:       string | null
  background_color:    string
  use_logo:            boolean
  logo_url:            string | null
  logo_storage_path:   string | null
  communication_tone:  string
  image_count:         number
  image_format:        string
  image_prompts:       string[] | null
  video_prompts:       string[] | null
  marketplace_rules:   Record<string, unknown>
  is_active:           boolean
  /** F6: tipo de produto (template de imagens). NULL = auto-match por categoria ML. */
  template_id:         string | null
  /** F6: posições/slots do template que serão geradas (1 imagem por slot).
   *  Array vazio = usa N primeiras conforme image_count antigo. */
  selected_positions:  number[]
  created_at:          string
  updated_at:          string
}

export interface CreativeListing {
  id:                       string
  product_id:               string
  briefing_id:              string
  organization_id:          string
  title:                    string
  subtitle:                 string | null
  description:              string
  bullets:                  string[]
  technical_sheet:          Record<string, unknown>
  /** Fonte única dos atributos ML — id→value_id/value_name. value_id "-1" = não se aplica. */
  ml_attributes:            Array<{ id: string; value_id?: string; value_name?: string }>
  keywords:                 string[]
  search_tags:              string[]
  suggested_category:       string | null
  faq:                      Array<{ q: string; a: string }>
  commercial_differentials: string[]
  marketplace_variants:     Record<string, unknown>
  version:                  number
  parent_listing_id:        string | null
  /** ML category ID (preenchido via predict_category) — usado pelo e-Otimizer */
  category_ml_id?:          string | null
  attributes_ml_suggested?: Array<{ id: string; name: string; value_id?: string; value_name?: string }>
  generation_metadata:      Record<string, unknown>
  status:                   'draft' | 'generating' | 'review' | 'approved' | 'published' | 'archived'
  approved_at:              string | null
  approved_by:              string | null
  created_at:               string
  updated_at:               string
}

// ── DTOs ──────────────────────────────────────────────────────────────────

export interface CreateProductDto {
  name:                     string
  category:                 string
  main_image_url:           string
  main_image_storage_path:  string
  brand?:                   string
  dimensions?:              Record<string, unknown>
  color?:                   string
  material?:                string
  differentials?:           string[]
  target_audience?:         string
  sku?:                     string
  ean?:                     string
  reference_images?:        string[]
  competitor_links?:        string[]
  reference_video_url?:     string
  brand_identity_url?:      string
  /** Onda 1 M1 — vincula direto ao catálogo no momento da criação */
  product_id?:              string
}

export type UpdateProductDto = Partial<CreateProductDto> & { product_id?: string | null }

export interface CreateBriefingDto {
  target_marketplace:  Marketplace
  visual_style?:       string
  /** @deprecated use environments[] */
  environment?:        string
  environments?:       string[]
  custom_environment?: string
  custom_prompt?:      string
  background_color?:   string
  use_logo?:           boolean
  logo_url?:           string
  logo_storage_path?:  string
  communication_tone?: string
  image_count?:        number
  image_prompts?:      string[]
  video_prompts?:      string[]
  image_format?:       string
  /** F6: tipo de produto (template) escolhido. NULL/omit = auto-match. */
  template_id?:        string | null
  /** F6: slots do template selecionados (1 imagem por slot). */
  selected_positions?: number[]
}

/** Caminho rápido — uma fonte de imagem pronta (Canva exportado ou upload). */
export interface QuickListingImageSource {
  /** URL acessível pra download (storage_url público do Canva ou signed URL do upload). */
  url:   string
  kind?: 'canva' | 'upload' | 'external'
}

/**
 * Caminho rápido ("Imagens prontas"): cria anúncio a partir de imagens já
 * prontas, pulando a geração por IA. Pode vincular a um produto do catálogo
 * (puxa os dados pra enriquecer) ou seguir sem vínculo.
 */
export interface QuickListingDto {
  /** Nome do produto. Obrigatório quando SEM vínculo; se vinculado, herda do catálogo. */
  name?:                string
  /** Vincula o anúncio a um produto do catálogo (puxa dados). NULL/omit = sem vínculo. */
  catalog_product_id?:  string | null
  target_marketplace?:  Marketplace
  /** Imagens prontas (≥1). A 1ª vira a capa do produto. */
  images:               QuickListingImageSource[]
  /**
   * Como preencher o texto do anúncio:
   *  - 'catalog' (default se vinculado) → puxa título/descrição/ficha do catálogo
   *  - 'ai'                             → gera com IA (LlmService)
   *  - 'blank' (default sem vínculo)    → mínimo, preenchido na tela de publicação
   */
  text_mode?:           'catalog' | 'ai' | 'blank'
}

@Injectable()
export class CreativeService {
  private readonly logger = new Logger(CreativeService.name)

  constructor(
    private readonly llm: LlmService,
    private readonly mercadolivre: MercadolivreService,
    private readonly research: CategoryResearchService,
  ) {}

  /**
   * Chama predict_category do ML pra um título e retorna categoria ML real + attributes.
   * Best-effort: falhas (sem internet, ML down, título vazio) retornam null sem
   * quebrar o fluxo de geração de listing. Logs warning.
   */
  private async predictMlCategory(title: string, targetMarketplace: string): Promise<{
    category_ml_id:          string | null
    attributes_ml_suggested: Array<{ id: string; name: string; value_id?: string; value_name?: string }>
  }> {
    // Só roda pra ML — outros marketplaces ficam pra sprints futuras
    if (targetMarketplace !== 'mercado_livre') {
      return { category_ml_id: null, attributes_ml_suggested: [] }
    }
    try {
      const r = await this.mercadolivre.predictCategory(title)
      return {
        category_ml_id:          r.category_id,
        attributes_ml_suggested: r.attributes ?? [],
      }
    } catch (e) {
      this.logger.warn(`[predictMlCategory] falhou pra "${title.slice(0, 60)}": ${(e as Error).message}`)
      return { category_ml_id: null, attributes_ml_suggested: [] }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // PRODUCTS
  // ════════════════════════════════════════════════════════════════════════

  /** Melhor EAN/GTIN de um produto do catálogo. Produto simples guarda o código
   *  em `gtin`/`ean` (nível de produto); produto VARIÁVEL (cor × tamanho) guarda
   *  o EAN POR VARIAÇÃO em `variations[].ean` e deixa as colunas de nível de
   *  produto vazias — por isso a busca só por `gtin` perdia o EAN nesses casos.
   *  Retorna o 1º EAN não-vazio: gtin → ean → primeira variação com EAN. */
  private resolveCatalogEan(row: {
    gtin?: string | null; ean?: string | null; variations?: unknown
  }): string | null {
    const head = ((row.gtin ?? row.ean) ?? '').trim()
    if (head) return head
    const vars = Array.isArray(row.variations) ? row.variations : []
    for (const v of vars) {
      const e = (v as { ean?: string | null } | null)?.ean
      if (typeof e === 'string' && e.trim()) return e.trim()
    }
    return null
  }

  /** Atributos ML universais preenchíveis direto do produto, sem depender da
   *  categoria: GTIN (do EAN) e BRAND (da marca). A tela de publicação lê
   *  `ml_attributes` — sem semear aqui, o GTIN/EAN sai vazio no anúncio mesmo o
   *  produto tendo o código. Os demais atributos seguem via IA "sugerir". */
  private baseMlAttributes(product: CreativeProduct): Array<{ id: string; value_id?: string; value_name?: string }> {
    const attrs: Array<{ id: string; value_id?: string; value_name?: string }> = []
    if (product.ean?.trim())   attrs.push({ id: 'GTIN',  value_name: product.ean.trim() })
    if (product.brand?.trim()) attrs.push({ id: 'BRAND', value_name: product.brand.trim() })
    return attrs
  }

  async createProduct(orgId: string, userId: string, dto: CreateProductDto): Promise<CreativeProduct> {
    if (!dto.name?.trim()) throw new BadRequestException('name obrigatório')
    if (!dto.category?.trim()) throw new BadRequestException('category obrigatório')
    if (!dto.main_image_url?.trim()) throw new BadRequestException('main_image_url obrigatório')
    if (!dto.main_image_storage_path?.trim()) throw new BadRequestException('main_image_storage_path obrigatório')

    // Se product_id passado, valida que pertence ao mesmo org
    if (dto.product_id) {
      await this.assertCatalogProductInOrg(orgId, dto.product_id)
    }

    const { data, error } = await supabaseAdmin
      .from('creative_products')
      .insert({
        organization_id:         orgId,
        user_id:                 userId,
        name:                    dto.name.trim(),
        category:                dto.category.trim(),
        brand:                   dto.brand ?? null,
        main_image_url:          dto.main_image_url,
        main_image_storage_path: dto.main_image_storage_path,
        dimensions:              dto.dimensions ?? {},
        color:                   dto.color ?? null,
        material:                dto.material ?? null,
        differentials:           dto.differentials ?? [],
        target_audience:         dto.target_audience ?? null,
        sku:                     dto.sku ?? null,
        ean:                     dto.ean ?? null,
        reference_images:        dto.reference_images ?? [],
        competitor_links:        dto.competitor_links ?? [],
        reference_video_url:     dto.reference_video_url ?? null,
        brand_identity_url:      dto.brand_identity_url ?? null,
        product_id:              dto.product_id ?? null,
        status:                  'draft',
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`createProduct: ${error.message}`)
    return data as CreativeProduct
  }

  /** Valida que catalog_product pertence à mesma org. Lança 404/403. */
  private async assertCatalogProductInOrg(orgId: string, catalogProductId: string): Promise<void> {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('id, organization_id')
      .eq('id', catalogProductId)
      .maybeSingle()
    if (error) throw new BadRequestException(`assertCatalog: ${error.message}`)
    if (!data) throw new NotFoundException('produto do catálogo não encontrado')
    if ((data as { organization_id: string | null }).organization_id !== orgId) {
      throw new ForbiddenException('produto do catálogo pertence a outra organização')
    }
  }

  async listProducts(orgId: string, opts: {
    status?:        string
    search?:        string
    sort?:          'recent' | 'name'
    include_archived?: boolean
    limit?:         number
  } = {}): Promise<Array<CreativeProduct & { signed_image_url: string | null }>> {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50))
    let q = supabaseAdmin
      .from('creative_products')
      .select('*')
      .eq('organization_id', orgId)
      .limit(limit)

    if (!opts.include_archived) q = q.neq('status', 'archived')
    if (opts.status)            q = q.eq('status', opts.status)

    // Search por name/sku/brand case-insensitive
    if (opts.search?.trim()) {
      const s = opts.search.trim().replace(/[,%]/g, ' ')
      q = q.or(`name.ilike.%${s}%,sku.ilike.%${s}%,brand.ilike.%${s}%`)
    }

    // Sort
    if (opts.sort === 'name') {
      q = q.order('name', { ascending: true })
    } else {
      q = q.order('created_at', { ascending: false })
    }

    const { data, error } = await q
    if (error) throw new BadRequestException(`listProducts: ${error.message}`)
    const products = (data ?? []) as CreativeProduct[]
    return Promise.all(products.map(async p => ({
      ...p,
      signed_image_url: await this.signImage(p.main_image_storage_path, 3600).catch(() => null),
    })))
  }

  async getProduct(orgId: string, id: string): Promise<CreativeProduct> {
    const { data, error } = await supabaseAdmin
      .from('creative_products')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new BadRequestException(`getProduct: ${error.message}`)
    if (!data) throw new NotFoundException('product não encontrado')
    return data as CreativeProduct
  }

  /** Como `getProduct` mas embute signed_image_url fresca (1h TTL) — usar
   *  no controller pra evitar 2 chamadas separadas do frontend. */
  async getProductWithSignedUrl(orgId: string, id: string): Promise<CreativeProduct & { signed_image_url: string | null }> {
    const product = await this.getProduct(orgId, id)
    const signed = await this.signImage(product.main_image_storage_path, 3600).catch(() => null)
    return { ...product, signed_image_url: signed }
  }

  async updateProduct(orgId: string, id: string, dto: UpdateProductDto): Promise<CreativeProduct> {
    await this.getProduct(orgId, id) // valida existência + tenant

    // Se product_id passado (não-null), valida tenant. Aceitar null = desvincular.
    if (dto.product_id) {
      await this.assertCatalogProductInOrg(orgId, dto.product_id)
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const k of Object.keys(dto) as Array<keyof UpdateProductDto>) {
      if (dto[k] !== undefined) patch[k] = dto[k]
    }
    const { data, error } = await supabaseAdmin
      .from('creative_products')
      .update(patch)
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`updateProduct: ${error.message}`)
    return data as CreativeProduct
  }

  // ════════════════════════════════════════════════════════════════════════
  // Onda 1 M1 — Bridge Creative ↔ Catálogo
  // ════════════════════════════════════════════════════════════════════════

  /** Lista creative_products vinculados a um produto do catálogo. */
  async listCreativesForCatalogProduct(orgId: string, catalogProductId: string): Promise<CreativeProduct[]> {
    await this.assertCatalogProductInOrg(orgId, catalogProductId)
    const { data, error } = await supabaseAdmin
      .from('creative_products')
      .select('*')
      .eq('organization_id', orgId)
      .eq('product_id', catalogProductId)
      .neq('status', 'archived')
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw new BadRequestException(`listCreativesForCatalogProduct: ${error.message}`)
    return (data ?? []) as CreativeProduct[]
  }

  /**
   * Prefill pro deeplink de cadastro: dado um produto do catálogo, retorna
   * (a) os creative_products já vinculados e (b) TODOS os dados aproveitáveis
   * do catálogo pra pré-preencher a tela de novo anúncio — Step 1 (nome/
   * categoria/marca/fotos) e Step 2 (cor, material, dimensões, peso, público,
   * características, SKU, EAN) + custo de referência. A chave produto↔anúncio
   * é o SKU. O frontend usa pra decidir: redirecionar pro anúncio existente
   * ou abrir o fluxo de criação já preenchido (tudo editável pelo operador).
   *
   * Unidades: dimensões saem como "X cm" e peso como "X kg" — exatamente o que
   * o publisher (`parsePackageDim`) espera pra mapear SELLER_PACKAGE_*.
   *
   * Custo: `cost_price` já vem LÍQUIDO do catálogo (o sync Icarus aplica o
   * desconto do fornecedor ao gravar — ver supplier-cost.util). Por isso NÃO
   * re-aplicamos desconto aqui; devolvemos o líquido + o bruto/% do fornecedor
   * só pra transparência.
   */
  async getCatalogPrefill(orgId: string, catalogProductId: string): Promise<{
    existing: Array<{ id: string; name: string; status: string }>
    catalog:  {
      id: string; name: string; category: string | null; brand: string | null; photo_urls: string[]
      sku: string | null; ean: string | null
      color: string | null; material: string | null
      width: string | null; height: string | null; depth: string | null; weight: string | null
      target_audience: string | null; differentials: string[]
      cost: {
        net: number | null; gross: number | null
        discount_type: CostAdjustmentType | null; discount_value: number | null
        tax_percentage: number | null; tax_on_freight: boolean
        supplier_name: string | null
      }
    }
  }> {
    await this.assertCatalogProductInOrg(orgId, catalogProductId)
    const { data: cat, error } = await supabaseAdmin
      .from('products')
      .select('id, name, category, brand, photo_urls, sku, gtin, ean, variations, attributes, weight_kg, width_cm, length_cm, height_cm, cost_price, tax_percentage, tax_on_freight, ai_target_audience, differentials, preferred_supplier_id')
      .eq('id', catalogProductId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) throw new BadRequestException(`getCatalogPrefill: ${error.message}`)
    if (!cat) throw new NotFoundException('produto do catálogo não encontrado')

    const c = cat as {
      id: string; name: string; category: string | null; brand: string | null; photo_urls: string[] | null
      sku: string | null; gtin: string | null; ean: string | null; variations: unknown; attributes: Record<string, unknown> | null
      weight_kg: number | null; width_cm: number | null; length_cm: number | null; height_cm: number | null
      cost_price: number | null; tax_percentage: number | null; tax_on_freight: boolean | null
      ai_target_audience: string | null; differentials: unknown
      preferred_supplier_id: string | null
    }

    // Cor/material moram no JSONB `attributes` (não há coluna dedicada).
    const attrs = (c.attributes ?? {}) as Record<string, unknown>
    const asStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
    const dim = (v: number | null, unit: 'cm' | 'kg'): string | null =>
      v != null && Number(v) > 0 ? `${v} ${unit}` : null
    const differentials = Array.isArray(c.differentials)
      ? (c.differentials as unknown[]).filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
      : []

    // Custo: líquido vem direto do produto. Bruto + % do fornecedor (se houver
    // vínculo) só pra transparência — efetivo = ajuste do produto ou o geral.
    let gross: number | null = null
    let discountType: CostAdjustmentType | null = null
    let discountValue: number | null = null
    let supplierName: string | null = null
    if (c.preferred_supplier_id) {
      const [{ data: sp }, { data: sup }] = await Promise.all([
        supabaseAdmin
          .from('supplier_products')
          .select('supplier_gross_price, cost_adjustment_type, cost_adjustment_value')
          .eq('organization_id', orgId)
          .eq('product_id', catalogProductId)
          .eq('supplier_id', c.preferred_supplier_id)
          .maybeSingle(),
        supabaseAdmin
          .from('suppliers')
          .select('name, default_cost_adjustment_type, default_cost_adjustment_value')
          .eq('organization_id', orgId)
          .eq('id', c.preferred_supplier_id)
          .maybeSingle(),
      ])
      if (sup) supplierName = (sup as { name: string | null }).name ?? null
      if (sp) {
        gross = (sp as { supplier_gross_price: number | null }).supplier_gross_price ?? null
        const productAdj: CostAdjustment = {
          type:  ((sp as { cost_adjustment_type: CostAdjustmentType | null }).cost_adjustment_type) ?? null,
          value: Number((sp as { cost_adjustment_value: number | null }).cost_adjustment_value) || 0,
        }
        const supplierDefault: CostAdjustment = {
          type:  ((sup as { default_cost_adjustment_type: CostAdjustmentType | null } | null)?.default_cost_adjustment_type) ?? null,
          value: Number((sup as { default_cost_adjustment_value: number | null } | null)?.default_cost_adjustment_value) || 0,
        }
        const eff = resolveAdjustment(productAdj, supplierDefault)
        discountType  = eff.type
        discountValue = eff.type ? eff.value : null
      }
    }

    const creatives = await this.listCreativesForCatalogProduct(orgId, catalogProductId)
    return {
      existing: creatives.map(cr => ({ id: cr.id, name: cr.name, status: cr.status })),
      catalog: {
        id:              c.id,
        name:            c.name,
        category:        c.category,
        brand:           c.brand,
        photo_urls:      c.photo_urls ?? [],
        sku:             c.sku,
        ean:             this.resolveCatalogEan(c),
        color:           asStr(attrs.color),
        material:        asStr(attrs.material),
        width:           dim(c.width_cm,  'cm'),
        height:          dim(c.height_cm, 'cm'),
        depth:           dim(c.length_cm, 'cm'),
        weight:          dim(c.weight_kg, 'kg'),
        target_audience: c.ai_target_audience,
        differentials,
        cost: {
          net:            c.cost_price,
          gross,
          discount_type:  discountType,
          discount_value: discountValue,
          tax_percentage: c.tax_percentage,
          tax_on_freight: c.tax_on_freight ?? false,
          supplier_name:  supplierName,
        },
      },
    }
  }

  /**
   * Importa as fotos do produto do catálogo como imagens do anúncio
   * (`creative_images` aprovadas), pra o operador publicar sem precisar gerar
   * imagens com IA. Cobre o pedido "se já houver imagens, passar sem criar".
   *
   * Como `creative_images.job_id` é NOT NULL, cria um job de import (custo
   * zero, `prompts_metadata.source = 'catalog_import'`) só pra hospedar as
   * imagens — o publish/ML continua lendo de `creative_images` sem mudança.
   *
   * Idempotente: se já existe job de import pra esse produto, não duplica.
   * Best-effort por foto: uma que falhe o download não aborta as demais.
   */
  async importCatalogImagesAsCreativeImages(
    orgId:             string,
    creativeProductId: string,
    briefingId:        string,
  ): Promise<{ imported: number; skipped: 'no_link' | 'no_photos' | 'already_imported' | null }> {
    const creative = await this.getProduct(orgId, creativeProductId)
    if (!creative.product_id) return { imported: 0, skipped: 'no_link' }

    // Idempotência: já importou antes pra esse produto?
    const { data: priorJob } = await supabaseAdmin
      .from('creative_image_jobs')
      .select('id')
      .eq('product_id', creativeProductId)
      .eq('prompts_metadata->>source', 'catalog_import')
      .limit(1)
      .maybeSingle()
    if (priorJob) return { imported: 0, skipped: 'already_imported' }

    // Fotos do catálogo (ML aceita 10 — limita a 12 com folga)
    const { data: cat } = await supabaseAdmin
      .from('products')
      .select('photo_urls')
      .eq('id', creative.product_id)
      .eq('organization_id', orgId)
      .maybeSingle()
    const photoUrls = (((cat as { photo_urls: string[] | null } | null)?.photo_urls) ?? []).slice(0, 12)
    if (photoUrls.length === 0) return { imported: 0, skipped: 'no_photos' }

    // Job de import — custo zero, status já completed (não passa pelo worker)
    const nowIso = new Date().toISOString()
    const { data: job, error: jobErr } = await supabaseAdmin
      .from('creative_image_jobs')
      .insert({
        organization_id:  orgId,
        product_id:       creativeProductId,
        briefing_id:      briefingId,
        status:           'completed',
        requested_count:  photoUrls.length,
        completed_count:  photoUrls.length,
        approved_count:   photoUrls.length,
        max_cost_usd:     0,
        total_cost_usd:   0,
        prompts_metadata: { source: 'catalog_import' },
        started_at:       nowIso,
        completed_at:     nowIso,
      })
      .select('id')
      .single()
    if (jobErr || !job) throw new BadRequestException(`importCatalogImages.job: ${jobErr?.message}`)

    let imported = 0
    for (let i = 0; i < photoUrls.length; i++) {
      try {
        const resp = await fetch(photoUrls[i])
        if (!resp.ok) { this.logger.warn(`[catalog-import] foto ${i} HTTP ${resp.status}`); continue }
        const buffer = Buffer.from(await resp.arrayBuffer())
        const contentType = resp.headers.get('content-type') || 'image/jpeg'
        const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg'
        const imageId = randomUUID()
        const storagePath = `${orgId}/${creativeProductId}/images/${imageId}.${ext}`

        const { error: upErr } = await supabaseAdmin.storage
          .from('creative')
          .upload(storagePath, buffer, { contentType, upsert: true, cacheControl: '3600' })
        if (upErr) { this.logger.warn(`[catalog-import] upload foto ${i}: ${upErr.message}`); continue }

        const { error: insErr } = await supabaseAdmin
          .from('creative_images')
          .insert({
            id:                  imageId,
            job_id:              job.id,
            product_id:          creativeProductId,
            organization_id:     orgId,
            position:            i + 1,
            prompt_text:         'Imagem importada do catálogo',
            status:              'approved',
            storage_path:        storagePath,
            approved_at:         nowIso,
            generation_metadata: { source: 'catalog_import', original_url: photoUrls[i] },
          })
        if (insErr) { this.logger.warn(`[catalog-import] insert foto ${i}: ${insErr.message}`); continue }
        imported++
      } catch (e) {
        this.logger.warn(`[catalog-import] foto ${i} falhou: ${(e as Error).message}`)
      }
    }

    this.logger.log(`[catalog-import] produto ${creativeProductId}: ${imported}/${photoUrls.length} fotos importadas`)
    return { imported, skipped: null }
  }

  // ════════════════════════════════════════════════════════════════════════
  // QUICK LISTING — caminho rápido ("Imagens prontas": Canva + upload externo)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Cria um anúncio a partir de imagens JÁ PRONTAS (designs exportados do Canva
   * e/ou uploads externos), pulando a geração por IA. Reúne as peças que já
   * existem: createProduct/createCreativeFromCatalogProduct + import de imagens
   * aprovadas + listing (catálogo / IA / em branco). Devolve o listing pronto
   * pra o frontend cair direto na tela de publicação.
   */
  async createQuickListing(
    orgId:  string,
    userId: string,
    dto:    QuickListingDto,
  ): Promise<{ creative_product_id: string; listing_id: string; images_imported: number }> {
    const images = (dto.images ?? []).filter(i => i?.url?.trim())
    if (images.length === 0) throw new BadRequestException('selecione ao menos 1 imagem')
    const marketplace = dto.target_marketplace ?? 'mercado_livre'

    // 1. A 1ª imagem vira a capa do produto (bucket privado `creative`).
    const cover = await this.fetchAndUploadToCreativeBucket(orgId, `${orgId}/quick-main`, images[0].url)
    const coverSigned = await this.signImage(cover.storage_path, 3600).catch(() => images[0].url)

    // 2. Cria o produto — vinculado ao catálogo (puxa dados) ou avulso.
    let product: CreativeProduct
    if (dto.catalog_product_id) {
      product = await this.createCreativeFromCatalogProduct(orgId, userId, dto.catalog_product_id, {
        main_image_url:          coverSigned,
        main_image_storage_path: cover.storage_path,
      })
    } else {
      if (!dto.name?.trim()) throw new BadRequestException('name obrigatório quando sem vínculo')
      product = await this.createProduct(orgId, userId, {
        name:                    dto.name.trim(),
        category:                'Diversos',
        main_image_url:          coverSigned,
        main_image_storage_path: cover.storage_path,
      })
    }

    // 3. Briefing mínimo (só carimba o marketplace alvo).
    const briefing = await this.createBriefing(orgId, product.id, { target_marketplace: marketplace })

    // 4. Importa TODAS as imagens como creative_images APROVADAS.
    const imported = await this.importImageSourcesAsApproved(orgId, product.id, briefing.id, images)
    if (imported === 0) throw new BadRequestException('nenhuma imagem pôde ser importada — verifique as fontes')

    // 5. Cria o anúncio textual conforme o modo escolhido.
    const textMode = dto.text_mode ?? (dto.catalog_product_id ? 'catalog' : 'blank')
    let listing: CreativeListing
    if (textMode === 'ai') {
      listing = await this.generateListing(orgId, product.id, briefing.id)
    } else if (textMode === 'catalog' && product.product_id) {
      listing = await this.createCatalogEnrichedListing(orgId, product, briefing)
    } else {
      listing = await this.createBlankListing(orgId, product, briefing)
    }

    this.logger.log(`[quick-listing] org=${orgId} produto=${product.id} listing=${listing.id} imgs=${imported} modo=${textMode}`)
    return { creative_product_id: product.id, listing_id: listing.id, images_imported: imported }
  }

  /** Baixa uma imagem por URL e sobe pro bucket `creative`. Retorna o path. */
  private async fetchAndUploadToCreativeBucket(
    orgId:     string,
    pathPrefix: string,
    sourceUrl: string,
  ): Promise<{ storage_path: string; content_type: string }> {
    let resp: Response
    try {
      resp = await fetch(sourceUrl)
    } catch (e) {
      throw new BadRequestException(`baixar imagem falhou: ${(e as Error).message}`)
    }
    if (!resp.ok) throw new BadRequestException(`baixar imagem: HTTP ${resp.status}`)
    const buffer = Buffer.from(await resp.arrayBuffer())
    const contentType = resp.headers.get('content-type') || 'image/jpeg'
    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg'
    const storagePath = `${pathPrefix}/${randomUUID()}.${ext}`
    const { error } = await supabaseAdmin.storage
      .from('creative')
      .upload(storagePath, buffer, { contentType, upsert: true, cacheControl: '3600' })
    if (error) throw new BadRequestException(`upload imagem: ${error.message}`)
    return { storage_path: storagePath, content_type: contentType }
  }

  /**
   * Importa um conjunto de fontes de imagem como creative_images APROVADAS sob
   * um job de custo zero (`source = 'quick_import'`). Best-effort por imagem.
   * Generaliza o que importCatalogImagesAsCreativeImages faz só pro catálogo.
   */
  private async importImageSourcesAsApproved(
    orgId:             string,
    creativeProductId: string,
    briefingId:        string,
    sources:           QuickListingImageSource[],
  ): Promise<number> {
    const nowIso = new Date().toISOString()
    const { data: job, error: jobErr } = await supabaseAdmin
      .from('creative_image_jobs')
      .insert({
        organization_id:  orgId,
        product_id:       creativeProductId,
        briefing_id:      briefingId,
        status:           'completed',
        requested_count:  sources.length,
        completed_count:  sources.length,
        approved_count:   sources.length,
        max_cost_usd:     0,
        total_cost_usd:   0,
        prompts_metadata: { source: 'quick_import' },
        started_at:       nowIso,
        completed_at:     nowIso,
      })
      .select('id')
      .single()
    if (jobErr || !job) throw new BadRequestException(`quickImport.job: ${jobErr?.message}`)

    let imported = 0
    for (let i = 0; i < sources.length; i++) {
      try {
        const src = sources[i]
        const resp = await fetch(src.url)
        if (!resp.ok) { this.logger.warn(`[quick-import] img ${i} HTTP ${resp.status}`); continue }
        const buffer = Buffer.from(await resp.arrayBuffer())
        const contentType = resp.headers.get('content-type') || 'image/jpeg'
        const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg'
        const imageId = randomUUID()
        const storagePath = `${orgId}/${creativeProductId}/images/${imageId}.${ext}`

        const { error: upErr } = await supabaseAdmin.storage
          .from('creative')
          .upload(storagePath, buffer, { contentType, upsert: true, cacheControl: '3600' })
        if (upErr) { this.logger.warn(`[quick-import] upload ${i}: ${upErr.message}`); continue }

        const { error: insErr } = await supabaseAdmin
          .from('creative_images')
          .insert({
            id:                  imageId,
            job_id:              job.id,
            product_id:          creativeProductId,
            organization_id:     orgId,
            position:            i + 1,
            prompt_text:         src.kind === 'canva' ? 'Design importado do Canva' : 'Imagem enviada manualmente',
            status:              'approved',
            storage_path:        storagePath,
            approved_at:         nowIso,
            generation_metadata: { source: 'quick_import', kind: src.kind ?? 'external', original_url: src.url },
          })
        if (insErr) { this.logger.warn(`[quick-import] insert ${i}: ${insErr.message}`); continue }
        imported++
      } catch (e) {
        this.logger.warn(`[quick-import] img ${i} falhou: ${(e as Error).message}`)
      }
    }

    this.logger.log(`[quick-import] produto ${creativeProductId}: ${imported}/${sources.length} imagens importadas`)
    return imported
  }

  /** Anúncio mínimo (sem IA, sem catálogo): só título = nome do produto. O
   *  resto o usuário preenche na tela de publicação. */
  private async createBlankListing(
    orgId:    string,
    product:  CreativeProduct,
    briefing: CreativeBriefing,
  ): Promise<CreativeListing> {
    const mlPred = await this.predictMlCategory(product.name, briefing.target_marketplace)
    const { data, error } = await supabaseAdmin
      .from('creative_listings')
      .insert({
        product_id:               product.id,
        briefing_id:              briefing.id,
        organization_id:          orgId,
        title:                    product.name,
        subtitle:                 null,
        description:              '',
        bullets:                  [],
        technical_sheet:          {},
        ml_attributes:            this.baseMlAttributes(product),
        keywords:                 [],
        search_tags:              [],
        suggested_category:       product.category,
        category_ml_id:           mlPred.category_ml_id,
        attributes_ml_suggested:  mlPred.attributes_ml_suggested,
        faq:                      [],
        commercial_differentials: [],
        marketplace_variants:     {},
        version:                  1,
        parent_listing_id:        null,
        generation_metadata:      { source: 'quick_blank' },
        status:                   'review',
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`createBlankListing: ${error.message}`)
    return data as CreativeListing
  }

  /** Anúncio enriquecido com os dados do produto do catálogo vinculado
   *  (título/descrição/ficha técnica), SEM IA. */
  private async createCatalogEnrichedListing(
    orgId:    string,
    product:  CreativeProduct,
    briefing: CreativeBriefing,
  ): Promise<CreativeListing> {
    // Puxa os campos ricos do catálogo (product.product_id garante vínculo).
    const { data: cat } = await supabaseAdmin
      .from('products')
      .select('name, ml_title, description, attributes')
      .eq('id', product.product_id as string)
      .eq('organization_id', orgId)
      .maybeSingle()
    const c = (cat ?? {}) as { name?: string; ml_title?: string | null; description?: string | null; attributes?: Record<string, unknown> | null }

    const title = (c.ml_title?.trim() || c.name?.trim() || product.name).slice(0, 60)
    const description = (c.description ?? '').trim()

    // Ficha técnica: atributos do catálogo (valores escalares) + dimensões.
    const technicalSheet: Record<string, unknown> = {}
    if (c.attributes && typeof c.attributes === 'object') {
      for (const [k, v] of Object.entries(c.attributes)) {
        if (v == null) continue
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') technicalSheet[k] = v
      }
    }
    const dims = (product.dimensions ?? {}) as Record<string, unknown>
    for (const [k, v] of Object.entries(dims)) {
      if (typeof v === 'string' || typeof v === 'number') technicalSheet[k] = v
    }

    const mlPred = await this.predictMlCategory(title, briefing.target_marketplace)

    const { data, error } = await supabaseAdmin
      .from('creative_listings')
      .insert({
        product_id:               product.id,
        briefing_id:              briefing.id,
        organization_id:          orgId,
        title,
        subtitle:                 null,
        description,
        bullets:                  product.differentials ?? [],
        technical_sheet:          technicalSheet,
        ml_attributes:            this.baseMlAttributes(product),
        keywords:                 [],
        search_tags:              [],
        suggested_category:       product.category,
        category_ml_id:           mlPred.category_ml_id,
        attributes_ml_suggested:  mlPred.attributes_ml_suggested,
        faq:                      [],
        commercial_differentials: product.differentials ?? [],
        marketplace_variants:     {},
        version:                  1,
        parent_listing_id:        null,
        generation_metadata:      { source: 'quick_catalog', catalog_product_id: product.product_id },
        status:                   'review',
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`createCatalogEnrichedListing: ${error.message}`)
    return data as CreativeListing
  }

  /** Cria creative_product pré-preenchido com dados de um produto do catálogo.
   *  Usuário ainda precisa subir imagem (main_image_url + main_image_storage_path
   *  vêm do upload no frontend, este service só cria a row). */
  async createCreativeFromCatalogProduct(
    orgId: string,
    userId: string,
    catalogProductId: string,
    upload: { main_image_url: string; main_image_storage_path: string },
  ): Promise<CreativeProduct> {
    if (!upload.main_image_url || !upload.main_image_storage_path) {
      throw new BadRequestException('main_image_url e main_image_storage_path obrigatórios')
    }

    // Pega catalog product (já valida tenant)
    const { data: catalog, error } = await supabaseAdmin
      .from('products')
      .select('id, organization_id, name, brand, category, sku, gtin, ean, variations, weight_kg, width_cm, length_cm, height_cm, attributes, description, photo_urls')
      .eq('id', catalogProductId)
      .maybeSingle()
    if (error) throw new BadRequestException(`fetchCatalog: ${error.message}`)
    if (!catalog) throw new NotFoundException('produto do catálogo não encontrado')
    const cat = catalog as {
      id: string; organization_id: string | null; name: string; brand: string | null;
      category: string | null; sku: string | null; gtin: string | null; ean: string | null; variations: unknown;
      weight_kg: number | null; width_cm: number | null; length_cm: number | null;
      height_cm: number | null; attributes: Record<string, unknown> | null;
      description: string | null; photo_urls: string[] | null;
    }
    if (cat.organization_id !== orgId) {
      throw new ForbiddenException('produto do catálogo pertence a outra organização')
    }

    // Pré-preenche creative_product a partir do catalog
    const dimensions: Record<string, string> = {}
    if (cat.weight_kg) dimensions.peso         = `${cat.weight_kg} kg`
    if (cat.width_cm)  dimensions.largura      = `${cat.width_cm} cm`
    if (cat.length_cm) dimensions.profundidade = `${cat.length_cm} cm`
    if (cat.height_cm) dimensions.altura       = `${cat.height_cm} cm`

    return this.createProduct(orgId, userId, {
      name:                    cat.name,
      category:                cat.category ?? 'Diversos',
      brand:                   cat.brand ?? undefined,
      main_image_url:          upload.main_image_url,
      main_image_storage_path: upload.main_image_storage_path,
      dimensions:              Object.keys(dimensions).length > 0 ? dimensions : undefined,
      sku:                     cat.sku ?? undefined,
      ean:                     this.resolveCatalogEan(cat) ?? undefined,
      reference_images:        cat.photo_urls ?? undefined,
      product_id:              cat.id,
    })
  }

  /** Cria um produto no catálogo (`products`) a partir de um creative_product
   *  e atualiza o vínculo. Usado quando user criou criativo do zero (cenário B)
   *  e depois quer "salvar no catálogo". */
  async creativeToCatalog(orgId: string, creativeId: string): Promise<{ creative: CreativeProduct; catalog_product_id: string }> {
    const creative = await this.getProduct(orgId, creativeId)
    if (creative.product_id) {
      throw new ConflictException(`criativo já vinculado ao catálogo (product_id=${creative.product_id})`)
    }

    // Extrai dimensions
    const dim = (creative.dimensions ?? {}) as Record<string, string>
    const parseNumber = (v: string | undefined): number | null => {
      if (!v) return null
      const m = v.match(/[\d.,]+/)?.[0]?.replace(',', '.')
      const n = m ? Number(m) : NaN
      return Number.isFinite(n) ? n : null
    }

    const { data: created, error } = await supabaseAdmin
      .from('products')
      .insert({
        organization_id: orgId,
        name:            creative.name,
        sku:             creative.sku,
        gtin:            creative.ean,
        brand:           creative.brand,
        category:        creative.category,
        description:     null,
        weight_kg:       parseNumber(dim.peso),
        width_cm:        parseNumber(dim.largura),
        length_cm:       parseNumber(dim.profundidade),
        height_cm:       parseNumber(dim.altura),
        photo_urls:      creative.main_image_url ? [creative.main_image_url, ...creative.reference_images] : creative.reference_images,
        attributes:      {
          color:           creative.color,
          material:        creative.material,
          target_audience: creative.target_audience,
          differentials:   creative.differentials,
          ai_analysis:     creative.ai_analysis,
        },
        status:          'draft',
        condition:       'new',
      })
      .select('id')
      .single()
    if (error) throw new BadRequestException(`creativeToCatalog.insert: ${error.message}`)
    const catalogId = (created as { id: string }).id

    // Atualiza vínculo
    await supabaseAdmin
      .from('creative_products')
      .update({ product_id: catalogId, updated_at: new Date().toISOString() })
      .eq('id', creative.id)

    const updated = await this.getProduct(orgId, creative.id)
    return { creative: updated, catalog_product_id: catalogId }
  }

  async archiveProduct(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('creative_products')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', id)
    if (error) throw new BadRequestException(`archiveProduct: ${error.message}`)
    return { ok: true }
  }

  // ════════════════════════════════════════════════════════════════════════
  // ANALYZE — Vision
  // ════════════════════════════════════════════════════════════════════════

  async analyzeProduct(orgId: string, id: string): Promise<CreativeProduct> {
    const product = await this.getProduct(orgId, id)
    await this.setStatus(id, 'analyzing')

    try {
      // Bucket creative é privado — gera signed URL fresca (5min TTL) a cada
      // chamada. URL salva em main_image_url no upload pode ter expirado.
      const signedUrl = await this.signImage(product.main_image_storage_path, 300)

      const out = await this.llm.analyzeImage({
        orgId,
        feature:    'creative_vision',
        imageUrl:   signedUrl,
        userPrompt: PRODUCT_ANALYSIS_PROMPT,
        jsonMode:   true,
        maxTokens:  1500,
        creative:   { productId: product.id, operation: 'product_analysis' },
      })

      const parsed = safeParseJson(out.text)
      if (!parsed) {
        await this.setStatus(id, 'ready') // mesmo sem análise, libera fluxo
        throw new BadRequestException('Vision retornou JSON inválido — tente novamente')
      }

      const { data, error } = await supabaseAdmin
        .from('creative_products')
        .update({
          ai_analysis: parsed,
          status:      'ready',
          updated_at:  new Date().toISOString(),
        })
        .eq('organization_id', orgId)
        .eq('id', id)
        .select('*')
        .single()
      if (error) throw new BadRequestException(`analyzeProduct.update: ${error.message}`)
      return data as CreativeProduct
    } catch (e) {
      await this.setStatus(id, 'ready')
      throw e
    }
  }

  private async setStatus(productId: string, status: CreativeProduct['status']): Promise<void> {
    await supabaseAdmin
      .from('creative_products')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', productId)
  }

  /** Gera signed URL pra um path do bucket privado `creative`. Usado pelas
   *  operações de IA (Vision, etc.) e exposto pelo controller pra o
   *  frontend renderizar thumbs sem precisar saber do path. */
  async signImage(storagePath: string, ttlSeconds = 300): Promise<string> {
    const { data, error } = await supabaseAdmin
      .storage
      .from('creative')
      .createSignedUrl(storagePath, ttlSeconds)
    if (error || !data?.signedUrl) {
      throw new BadRequestException(`signImage: ${error?.message ?? 'falhou'}`)
    }
    return data.signedUrl
  }

  // ════════════════════════════════════════════════════════════════════════
  // BRIEFINGS
  // ════════════════════════════════════════════════════════════════════════

  async createBriefing(orgId: string, productId: string, dto: CreateBriefingDto): Promise<CreativeBriefing> {
    await this.getProduct(orgId, productId) // tenant check
    if (!dto.target_marketplace) throw new BadRequestException('target_marketplace obrigatório')

    // F6: valida template_id + selected_positions (se passados)
    const templateId = dto.template_id ?? null
    let selectedPositions: number[] = []
    if (templateId) {
      const { data: tpl, error: tplErr } = await supabaseAdmin
        .from('creative_image_prompt_templates')
        .select('id, positions')
        .eq('id', templateId)
        .eq('organization_id', orgId)
        .maybeSingle()
      if (tplErr) throw new BadRequestException(`validar template: ${tplErr.message}`)
      if (!tpl) throw new BadRequestException('template_id inválido ou não pertence à org')

      if (dto.selected_positions && dto.selected_positions.length > 0) {
        if (!Array.isArray(dto.selected_positions) || dto.selected_positions.some(p => !Number.isInteger(p) || p < 1)) {
          throw new BadRequestException('selected_positions: array de inteiros >= 1')
        }
        const validPositions = new Set(
          (tpl.positions as Array<{ position: number }>).map(p => p.position),
        )
        const invalid = dto.selected_positions.filter(p => !validPositions.has(p))
        if (invalid.length > 0) {
          throw new BadRequestException(`selected_positions inválidas pra esse template: ${invalid.join(', ')}`)
        }
        // Dedup + ordena
        selectedPositions = [...new Set(dto.selected_positions)].sort((a, b) => a - b)
      }
    } else if (dto.selected_positions && dto.selected_positions.length > 0) {
      throw new BadRequestException('selected_positions exige template_id')
    }

    // Desativa briefings anteriores do mesmo produto (mantém só o ativo)
    await supabaseAdmin
      .from('creative_briefings')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('product_id', productId)
      .eq('is_active', true)

    const rules = getMarketplaceRules(dto.target_marketplace)
    // Se selected_positions preenchido, image_count vira N (1 por slot)
    const imageCount = selectedPositions.length > 0
      ? selectedPositions.length
      : (dto.image_count ?? 10)

    const { data, error } = await supabaseAdmin
      .from('creative_briefings')
      .insert({
        product_id:         productId,
        organization_id:    orgId,
        target_marketplace: dto.target_marketplace,
        visual_style:       dto.visual_style ?? 'clean',
        environments:       dto.environments ?? (dto.environment ? [dto.environment] : []),
        custom_environment: dto.custom_environment ?? null,
        custom_prompt:      dto.custom_prompt ?? null,
        background_color:   dto.background_color ?? '#FFFFFF',
        use_logo:           dto.use_logo ?? false,
        logo_url:           dto.logo_url ?? null,
        logo_storage_path:  dto.logo_storage_path ?? null,
        communication_tone: dto.communication_tone ?? 'vendedor',
        image_count:        imageCount,
        image_format:       dto.image_format ?? '1200x1200',
        image_prompts:      dto.image_prompts ?? null,
        video_prompts:      dto.video_prompts ?? null,
        marketplace_rules:  rules as unknown as Record<string, unknown>,
        is_active:          true,
        template_id:        templateId,
        selected_positions: selectedPositions,
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`createBriefing: ${error.message}`)
    return data as CreativeBriefing
  }

  async listBriefings(orgId: string, productId: string): Promise<CreativeBriefing[]> {
    await this.getProduct(orgId, productId)
    const { data, error } = await supabaseAdmin
      .from('creative_briefings')
      .select('*')
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
    if (error) throw new BadRequestException(`listBriefings: ${error.message}`)
    return (data ?? []) as CreativeBriefing[]
  }

  async getBriefing(orgId: string, briefingId: string): Promise<CreativeBriefing> {
    const { data, error } = await supabaseAdmin
      .from('creative_briefings')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', briefingId)
      .maybeSingle()
    if (error) throw new BadRequestException(`getBriefing: ${error.message}`)
    if (!data) throw new NotFoundException('briefing não encontrado')
    return data as CreativeBriefing
  }

  /** Atualiza qualquer campo do briefing — usado pra editar a base de
   *  prompts (image_prompts, video_prompts) e ajustes pontuais no fluxo. */
  async updateBriefing(orgId: string, briefingId: string, patch: Partial<{
    target_marketplace:  Marketplace
    visual_style:        string
    environments:        string[]
    custom_environment:  string | null
    custom_prompt:       string | null
    background_color:    string
    use_logo:            boolean
    logo_url:            string | null
    logo_storage_path:   string | null
    communication_tone:  string
    image_count:         number
    image_format:        string
    image_prompts:       string[] | null
    video_prompts:       string[] | null
  }>): Promise<CreativeBriefing> {
    // Sanity check de existência + scope da org
    await this.getBriefing(orgId, briefingId)

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const k of Object.keys(patch)) {
      const v = (patch as Record<string, unknown>)[k]
      if (v !== undefined) update[k] = v
    }

    const { data, error } = await supabaseAdmin
      .from('creative_briefings')
      .update(update)
      .eq('organization_id', orgId)
      .eq('id', briefingId)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`updateBriefing: ${error.message}`)
    return data as CreativeBriefing
  }

  /** Gera (via LLM) a base de prompts editaveis ligada ao briefing.
   *  Pipelines de imagem/video reusam essa base nas geracoes seguintes
   *  ao inves de chamar Sonnet toda vez. User pode editar a base entre
   *  geracoes pra refinar manualmente. */
  async generatePromptsBase(orgId: string, briefingId: string, opts: {
    scope:              'image' | 'video' | 'both'
    override?:          { provider: Provider; model: string }
    /** Default = briefing.image_count. */
    imageCount?:        number
    /** Default = 5. */
    videoCount?:        number
    /** Default = 10. */
    videoDurationSec?:  5 | 10
    /** Default = '9:16'. */
    videoAspectRatio?:  '1:1' | '16:9' | '9:16'
  }): Promise<CreativeBriefing> {
    const briefing = await this.getBriefing(orgId, briefingId)
    const product = await this.getProduct(orgId, briefing.product_id)

    const productInput = {
      name:            product.name,
      category:        product.category,
      brand:           product.brand,
      color:           product.color,
      material:        product.material,
      dimensions:      product.dimensions,
      differentials:   product.differentials,
      target_audience: product.target_audience,
      ai_analysis:     product.ai_analysis,
    }
    const briefingInput = {
      target_marketplace: briefing.target_marketplace,
      visual_style:       briefing.visual_style,
      environments:       briefing.environments ?? (briefing.environment ? [briefing.environment] : []),
      custom_environment: briefing.custom_environment,
      custom_prompt:      briefing.custom_prompt,
      background_color:   briefing.background_color,
      use_logo:           briefing.use_logo,
      communication_tone: briefing.communication_tone,
      image_count:        briefing.image_count,
    }

    const patch: { image_prompts?: string[]; video_prompts?: string[] } = {}

    if (opts.scope === 'image' || opts.scope === 'both') {
      const count = opts.imageCount ?? briefing.image_count ?? 10
      const out = await this.llm.generateText({
        orgId,
        feature:    'creative_image_prompts',
        userPrompt: buildImagePromptsRequest({ product: productInput, briefing: briefingInput, count }),
        jsonMode:   true,
        maxTokens:  4000,
        override:   opts.override,
        creative:   { productId: product.id, operation: 'prompts_base_image' },
      })
      patch.image_prompts = parsePromptsArrayJson(out.text, count)
    }

    if (opts.scope === 'video' || opts.scope === 'both') {
      const count = opts.videoCount ?? 5
      const durationSec = opts.videoDurationSec ?? 10
      const aspectRatio = opts.videoAspectRatio ?? '9:16'
      const out = await this.llm.generateText({
        orgId,
        feature:    'creative_video_prompts',
        userPrompt: buildVideoPromptsRequest({ product: productInput, briefing: briefingInput, count, durationSec, aspectRatio }),
        jsonMode:   true,
        maxTokens:  3000,
        override:   opts.override,
        creative:   { productId: product.id, operation: 'prompts_base_video' },
      })
      patch.video_prompts = parsePromptsArrayJson(out.text, count)
    }

    return this.updateBriefing(orgId, briefingId, patch)
  }

  // ════════════════════════════════════════════════════════════════════════
  // BRIEFING TEMPLATES (melhoria #2)
  // ════════════════════════════════════════════════════════════════════════

  async listBriefingTemplates(orgId: string): Promise<Array<Record<string, unknown>>> {
    const { data, error } = await supabaseAdmin
      .from('creative_briefing_templates')
      .select('*')
      .eq('organization_id', orgId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) throw new BadRequestException(`listBriefingTemplates: ${error.message}`)
    return (data ?? []) as Array<Record<string, unknown>>
  }

  async createBriefingTemplate(orgId: string, userId: string, dto: {
    name:                string
    description?:        string
    target_marketplace:  Marketplace
    visual_style?:       string
    /** @deprecated use environments[] */
    environment?:        string
    environments?:       string[]
    custom_environment?: string
    custom_prompt?:      string
    background_color?:   string
    use_logo?:           boolean
    logo_url?:           string
    logo_storage_path?:  string
    communication_tone?: string
    image_count?:        number
    image_format?:       string
    is_default?:         boolean
  }): Promise<Record<string, unknown>> {
    if (!dto.name?.trim())              throw new BadRequestException('name obrigatório')
    if (!dto.target_marketplace)        throw new BadRequestException('target_marketplace obrigatório')

    // Se vai ser default, desativa o atual default da org
    if (dto.is_default) {
      await supabaseAdmin
        .from('creative_briefing_templates')
        .update({ is_default: false, updated_at: new Date().toISOString() })
        .eq('organization_id', orgId)
        .eq('is_default', true)
    }

    const { data, error } = await supabaseAdmin
      .from('creative_briefing_templates')
      .insert({
        organization_id:     orgId,
        user_id:             userId,
        name:                dto.name.trim(),
        description:         dto.description ?? null,
        target_marketplace:  dto.target_marketplace,
        visual_style:        dto.visual_style ?? 'clean',
        environments:        dto.environments ?? (dto.environment ? [dto.environment] : []),
        custom_environment:  dto.custom_environment ?? null,
        custom_prompt:       dto.custom_prompt ?? null,
        background_color:    dto.background_color ?? '#FFFFFF',
        use_logo:            dto.use_logo ?? false,
        logo_url:            dto.logo_url ?? null,
        logo_storage_path:   dto.logo_storage_path ?? null,
        communication_tone:  dto.communication_tone ?? 'vendedor',
        image_count:         dto.image_count ?? 10,
        image_format:        dto.image_format ?? '1200x1200',
        is_default:          dto.is_default ?? false,
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`createBriefingTemplate: ${error.message}`)
    return data as Record<string, unknown>
  }

  async updateBriefingTemplate(orgId: string, id: string, patch: Partial<{
    name:                string
    description:         string
    target_marketplace:  Marketplace
    visual_style:        string
    /** @deprecated use environments[] */
    environment:         string
    environments:        string[]
    custom_environment:  string
    custom_prompt:       string
    background_color:    string
    use_logo:            boolean
    logo_url:            string
    logo_storage_path:   string
    communication_tone:  string
    image_count:         number
    image_format:        string
    is_default:          boolean
  }>): Promise<Record<string, unknown>> {
    if (patch.is_default === true) {
      await supabaseAdmin
        .from('creative_briefing_templates')
        .update({ is_default: false, updated_at: new Date().toISOString() })
        .eq('organization_id', orgId)
        .eq('is_default', true)
        .neq('id', id)
    }

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const k of Object.keys(patch)) {
      const v = (patch as Record<string, unknown>)[k]
      if (v !== undefined) update[k] = v
    }
    const { data, error } = await supabaseAdmin
      .from('creative_briefing_templates')
      .update(update)
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`updateBriefingTemplate: ${error.message}`)
    if (!data) throw new NotFoundException('template não encontrado')
    return data as Record<string, unknown>
  }

  async deleteBriefingTemplate(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('creative_briefing_templates')
      .delete()
      .eq('organization_id', orgId)
      .eq('id', id)
    if (error) throw new BadRequestException(`deleteBriefingTemplate: ${error.message}`)
    return { ok: true }
  }

  // ════════════════════════════════════════════════════════════════════════
  // LISTINGS — geração textual
  // ════════════════════════════════════════════════════════════════════════

  async generateListing(orgId: string, productId: string, briefingId: string): Promise<CreativeListing> {
    const product  = await this.getProduct(orgId, productId)
    const briefing = await this.getBriefing(orgId, briefingId)
    if (briefing.product_id !== product.id) {
      throw new BadRequestException('briefing pertence a outro produto')
    }

    // e-Otimizer IA: detecta categoria ML PRIMEIRO + roda research da categoria
    // pra alimentar a LLM com padrões reais. Best-effort — se ML cair, gera
    // sem research (fallback ao comportamento antigo).
    const earlyMlPred = await this.predictMlCategory(product.name, briefing.target_marketplace)
    const mlResearch  = await this.buildMlResearchForPrompt({
      orgId,
      categoryMlId: earlyMlPred.category_ml_id,
      product,
      marketplace:  briefing.target_marketplace,
    })

    const promptInput: ListingPromptInput = {
      product: {
        name:            product.name,
        category:        product.category,
        brand:           product.brand,
        color:           product.color,
        material:        product.material,
        dimensions:      product.dimensions,
        differentials:   product.differentials,
        target_audience: product.target_audience,
        ai_analysis:     product.ai_analysis,
      },
      briefing: {
        target_marketplace: briefing.target_marketplace,
        visual_style:       briefing.visual_style,
        communication_tone: briefing.communication_tone,
      },
      ml_research: mlResearch ?? undefined,
    }

    const out = await this.llm.generateText({
      orgId,
      feature:    'creative_listing',
      userPrompt: buildListingPrompt(promptInput),
      jsonMode:   true,
      maxTokens:  3000,
      creative:   { productId: product.id, operation: 'text_generation' },
    })

    const parsed = safeParseJson(out.text)
    if (!parsed) throw new BadRequestException('LLM retornou JSON inválido — tente regenerar')

    const fields = normalizeListingFields(parsed)

    // Refina categoria com o título gerado (mais preciso que o nome do produto)
    const mlPred = await this.predictMlCategory(fields.title, briefing.target_marketplace)
    const finalCategoryMlId = mlPred.category_ml_id ?? earlyMlPred.category_ml_id

    const { data, error } = await supabaseAdmin
      .from('creative_listings')
      .insert({
        product_id:               product.id,
        briefing_id:              briefing.id,
        organization_id:          orgId,
        title:                    fields.title,
        subtitle:                 fields.subtitle,
        description:              fields.description,
        bullets:                  fields.bullets,
        technical_sheet:          fields.technical_sheet,
        ml_attributes:            this.baseMlAttributes(product),
        keywords:                 fields.keywords,
        search_tags:              fields.search_tags,
        suggested_category:       fields.suggested_category,
        category_ml_id:           finalCategoryMlId,
        attributes_ml_suggested:  mlPred.attributes_ml_suggested,
        faq:                      fields.faq,
        commercial_differentials: fields.commercial_differentials,
        marketplace_variants:     {},
        version:                  1,
        parent_listing_id:        null,
        generation_metadata: {
          provider:      out.provider,
          model:         out.model,
          input_tokens:  out.inputTokens,
          output_tokens: out.outputTokens,
          cost_usd:      out.costUsd,
          latency_ms:    out.latencyMs,
          fallback_used: out.fallbackUsed,
          // e-Otimizer IA: rastreabilidade — quais anúncios serviram de base
          seo_sources: mlResearch ? {
            category_ml_id: mlResearch.category_ml_id,
            top_keywords_used: mlResearch.top_keywords.slice(0, 15).map(k => ({
              keyword:    k.keyword,
              frequency:  k.frequency,
              sources_mlb: k.sources_mlb,
              recommend:  k.recommend,
            })),
            competitors_analyzed: mlResearch.competitors_top5.map(c => c.title),
            avg_title_length: mlResearch.title_pattern.avg_length,
            price_median:     mlResearch.price_stats.median,
          } : null,
        },
        status: 'review',
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`generateListing.insert: ${error.message}`)
    return data as CreativeListing
  }

  /**
   * e-Otimizer IA — chama CategoryResearchService e mapeia pro shape esperado
   * pelo ListingPromptInput. Best-effort: se categoria não foi detectada ou
   * research falhou, retorna null e a LLM gera sem research data (fallback).
   */
  private async buildMlResearchForPrompt(args: {
    orgId:        string
    categoryMlId: string | null
    product:      CreativeProduct
    marketplace:  string
  }): Promise<ListingPromptInput['ml_research']> {
    if (!args.categoryMlId || args.marketplace !== 'mercado_livre') return undefined
    try {
      const query = args.product.name
        .split(/\s+/).slice(0, 5).join(' ')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .trim()
      if (!query) return undefined

      const userKeywords = [
        args.product.name,
        args.product.brand ?? '',
        args.product.color ?? '',
        args.product.material ?? '',
        args.product.category,
      ].flatMap(t => t.toLowerCase().split(/\s+/)).filter(Boolean)

      const research = await this.research.research({
        orgId:        args.orgId,
        categoryId:   args.categoryMlId,
        query,
        userKeywords,
        excludeSellerNicknames: ['VAZZO_'],
      })

      return {
        category_ml_id:   research.category_ml_id,
        category_name:    research.category_name,
        top_keywords:     research.top_keywords.map(k => ({
          keyword:    k.keyword,
          frequency:  k.frequency,
          sources_mlb: k.sources_mlb,
          recommend:  k.recommend,
        })),
        title_pattern: {
          avg_length:      research.title_pattern.avg_length,
          median_length:   research.title_pattern.median_length,
          top_first_words: research.title_pattern.top_first_words,
          examples:        research.title_pattern.examples,
        },
        attributes_stats: research.attributes_stats,
        competitors_top5: research.competitors_analyzed.slice(0, 5).map(c => ({
          title:           c.title,
          price:           c.price,
          sold_quantity:   c.sold_quantity,
          power_seller:    c.power_seller_status,
          catalog_listing: c.catalog_listing,
        })),
        price_stats: {
          median: research.price_stats.median,
          avg:    research.price_stats.avg,
          p25:    research.price_stats.p25,
          p75:    research.price_stats.p75,
        },
      }
    } catch (e) {
      this.logger.warn(`[generateListing] research falhou (gerando sem dados de mercado): ${(e as Error).message}`)
      return undefined
    }
  }

  async listListingsByProduct(orgId: string, productId: string): Promise<CreativeListing[]> {
    await this.getProduct(orgId, productId)
    const { data, error } = await supabaseAdmin
      .from('creative_listings')
      .select('*')
      .eq('organization_id', orgId)
      .eq('product_id', productId)
      .order('version', { ascending: false })
      .limit(50)
    if (error) throw new BadRequestException(`listListingsByProduct: ${error.message}`)
    return (data ?? []) as CreativeListing[]
  }

  async getListing(orgId: string, listingId: string): Promise<CreativeListing> {
    const { data, error } = await supabaseAdmin
      .from('creative_listings')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', listingId)
      .maybeSingle()
    if (error) throw new BadRequestException(`getListing: ${error.message}`)
    if (!data) throw new NotFoundException('listing não encontrado')
    return data as CreativeListing
  }

  async updateListing(orgId: string, listingId: string, patch: Partial<{
    title:                    string
    subtitle:                 string
    description:              string
    bullets:                  string[]
    technical_sheet:          Record<string, unknown>
    ml_attributes:            Array<{ id: string; value_id?: string; value_name?: string }>
    keywords:                 string[]
    search_tags:              string[]
    suggested_category:       string
    faq:                      Array<{ q: string; a: string }>
    commercial_differentials: string[]
  }>): Promise<CreativeListing> {
    await this.getListing(orgId, listingId)
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const k of Object.keys(patch)) {
      const v = (patch as Record<string, unknown>)[k]
      if (v !== undefined) update[k] = v
    }
    const { data, error } = await supabaseAdmin
      .from('creative_listings')
      .update(update)
      .eq('organization_id', orgId)
      .eq('id', listingId)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`updateListing: ${error.message}`)
    return data as CreativeListing
  }

  /** Cria nova versão do listing usando o mesmo product+briefing, com instrução
   * adicional opcional. Não modifica a versão anterior — versionamento via
   * parent_listing_id + version incremental. */
  async regenerateListing(orgId: string, listingId: string, refinement?: string): Promise<CreativeListing> {
    const previous = await this.getListing(orgId, listingId)
    const product  = await this.getProduct(orgId, previous.product_id)
    const briefing = await this.getBriefing(orgId, previous.briefing_id)

    // e-Otimizer IA: reaproveita category_ml_id já detectada na versão anterior
    // (evita re-predict que custa call ML) OU re-detecta se ausente.
    let categoryMlId = previous.category_ml_id
    if (!categoryMlId) {
      const pred = await this.predictMlCategory(product.name, briefing.target_marketplace)
      categoryMlId = pred.category_ml_id
    }
    const mlResearch = await this.buildMlResearchForPrompt({
      orgId,
      categoryMlId,
      product,
      marketplace: briefing.target_marketplace,
    })

    const promptInput: ListingPromptInput = {
      product: {
        name:            product.name,
        category:        product.category,
        brand:           product.brand,
        color:           product.color,
        material:        product.material,
        dimensions:      product.dimensions,
        differentials:   product.differentials,
        target_audience: product.target_audience,
        ai_analysis:     product.ai_analysis,
      },
      briefing: {
        target_marketplace: briefing.target_marketplace,
        visual_style:       briefing.visual_style,
        communication_tone: briefing.communication_tone,
      },
      refinement: refinement?.trim() || undefined,
      ml_research: mlResearch ?? undefined,
    }

    const out = await this.llm.generateText({
      orgId,
      feature:    'creative_listing',
      userPrompt: buildListingPrompt(promptInput),
      jsonMode:   true,
      maxTokens:  3000,
      creative:   { productId: product.id, operation: 'text_generation' },
    })

    const parsed = safeParseJson(out.text)
    if (!parsed) throw new BadRequestException('LLM retornou JSON inválido — tente novamente')
    const fields = normalizeListingFields(parsed)

    // Refina categoria com novo título
    const mlPred = await this.predictMlCategory(fields.title, briefing.target_marketplace)
    const finalCategoryMlId = mlPred.category_ml_id ?? categoryMlId

    // Preserva os atributos ML que o usuário já preencheu (regenerar mexe só no
    // texto) e garante GTIN/BRAND se estiverem faltando.
    const prevAttrs = Array.isArray(previous.ml_attributes) ? previous.ml_attributes : []
    const prevIds = new Set(prevAttrs.map(a => a.id))
    const mergedMlAttributes = [...prevAttrs, ...this.baseMlAttributes(product).filter(a => !prevIds.has(a.id))]

    const { data, error } = await supabaseAdmin
      .from('creative_listings')
      .insert({
        product_id:               product.id,
        briefing_id:              briefing.id,
        organization_id:          orgId,
        title:                    fields.title,
        subtitle:                 fields.subtitle,
        description:              fields.description,
        bullets:                  fields.bullets,
        technical_sheet:          fields.technical_sheet,
        ml_attributes:            mergedMlAttributes,
        keywords:                 fields.keywords,
        search_tags:              fields.search_tags,
        suggested_category:       fields.suggested_category,
        category_ml_id:           finalCategoryMlId,
        attributes_ml_suggested:  mlPred.attributes_ml_suggested,
        faq:                      fields.faq,
        commercial_differentials: fields.commercial_differentials,
        marketplace_variants:     {},
        version:                  previous.version + 1,
        parent_listing_id:        previous.id,
        generation_metadata: {
          provider:      out.provider,
          model:         out.model,
          input_tokens:  out.inputTokens,
          output_tokens: out.outputTokens,
          cost_usd:      out.costUsd,
          latency_ms:    out.latencyMs,
          fallback_used: out.fallbackUsed,
          refinement:    refinement ?? null,
          // e-Otimizer IA: rastreabilidade
          seo_sources: mlResearch ? {
            category_ml_id: mlResearch.category_ml_id,
            top_keywords_used: mlResearch.top_keywords.slice(0, 15).map(k => ({
              keyword:    k.keyword,
              frequency:  k.frequency,
              sources_mlb: k.sources_mlb,
              recommend:  k.recommend,
            })),
            competitors_analyzed: mlResearch.competitors_top5.map(c => c.title),
            avg_title_length: mlResearch.title_pattern.avg_length,
            price_median:     mlResearch.price_stats.median,
          } : null,
        },
        status: 'review',
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`regenerateListing.insert: ${error.message}`)
    return data as CreativeListing
  }

  async approveListing(orgId: string, listingId: string, userId: string): Promise<CreativeListing> {
    await this.getListing(orgId, listingId)
    const { data, error } = await supabaseAdmin
      .from('creative_listings')
      .update({
        status:      'approved',
        approved_at: new Date().toISOString(),
        approved_by: userId,
        updated_at:  new Date().toISOString(),
      })
      .eq('organization_id', orgId)
      .eq('id', listingId)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`approveListing: ${error.message}`)
    return data as CreativeListing
  }

  /**
   * Sub-sprint A: força re-predict da categoria ML pra um listing.
   * Útil quando user edita o título e quer atualizar a categoria sugerida.
   * Atualiza category_ml_id + attributes_ml_suggested no listing.
   */
  async refreshMlCategory(orgId: string, listingId: string): Promise<CreativeListing> {
    const listing = await this.getListing(orgId, listingId)
    const briefing = await this.getBriefing(orgId, listing.briefing_id)
    const mlPred = await this.predictMlCategory(listing.title, briefing.target_marketplace)

    const { data, error } = await supabaseAdmin
      .from('creative_listings')
      .update({
        category_ml_id:          mlPred.category_ml_id,
        attributes_ml_suggested: mlPred.attributes_ml_suggested,
        updated_at:              new Date().toISOString(),
      })
      .eq('organization_id', orgId)
      .eq('id', listingId)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`refreshMlCategory: ${error.message}`)
    return data as CreativeListing
  }

  /** Busca candidatos de categoria ML por palavra (pro seletor manual). */
  async searchMlCategories(query: string): Promise<Array<{ category_id: string; category_name: string; domain_name: string | null }>> {
    return this.mercadolivre.searchCategories(query)
  }

  /**
   * Define MANUALMENTE a categoria ML do anúncio (em vez do predict pelo título).
   * Valida a categoria buscando os atributos dela e atualiza attributes_ml_suggested
   * pra refletir a nova categoria. Lança 400 se a categoria não existir no ML.
   */
  async setListingMlCategory(orgId: string, listingId: string, categoryId: string): Promise<CreativeListing> {
    await this.getListing(orgId, listingId) // tenant check
    const cid = categoryId?.trim()
    if (!cid) throw new BadRequestException('category_id obrigatório')

    let suggested: Array<{ id: string; name: string }> = []
    try {
      const attrs = await this.mercadolivre.getCategoryAttributes(cid)
      if (attrs.length === 0) throw new Error('sem atributos')
      suggested = attrs.map(a => ({ id: a.id, name: a.name }))
    } catch {
      throw new BadRequestException(`Categoria ML "${cid}" inválida ou indisponível`)
    }

    const { data, error } = await supabaseAdmin
      .from('creative_listings')
      .update({
        category_ml_id:          cid,
        attributes_ml_suggested: suggested,
        updated_at:              new Date().toISOString(),
      })
      .eq('organization_id', orgId)
      .eq('id', listingId)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`setListingMlCategory: ${error.message}`)
    return data as CreativeListing
  }

  /**
   * Lista listing_types do ML (Free, Gold Especial, Gold Pro, Premium…).
   * Endpoint público, cache 1h via MercadolivreService.
   */
  async listMlListingTypes(): Promise<Array<{ id: string; name: string }>> {
    return this.mercadolivre.getListingTypes()
  }

  /**
   * Sub-sprint B (prep): retorna attributes REAIS de uma categoria ML.
   * UI usa pra montar ficha técnica ML-compatible.
   */
  async getMlCategoryAttributes(categoryId: string): Promise<Array<{
    id:                string
    name:              string
    value_type:        string
    required:          boolean
    value_max_length?: number
    values?:           Array<{ id: string; name: string }>
    hint?:             string
  }>> {
    const attrs = await this.mercadolivre.getCategoryAttributes(categoryId)
    return attrs.map(a => ({
      id:                a.id,
      name:              a.name,
      value_type:        a.value_type,
      required:          a.tags?.required === true || a.tags?.catalog_required === true,
      value_max_length:  a.value_max_length,
      values:            a.values,
      hint:              a.hint,
    }))
  }

  /** Gera variante do listing pra outro marketplace. Não cria row nova —
   * popula `marketplace_variants[<target>]` no listing existente. */
  async createVariant(orgId: string, listingId: string, target: Marketplace): Promise<CreativeListing> {
    const listing = await this.getListing(orgId, listingId)
    if ((listing.marketplace_variants ?? {})[target]) {
      throw new BadRequestException(`variante para ${target} já existe`)
    }

    const out = await this.llm.generateText({
      orgId,
      feature:    'creative_listing',
      userPrompt: buildVariantPrompt(
        { title: listing.title, description: listing.description, bullets: listing.bullets },
        target,
      ),
      jsonMode:   true,
      maxTokens:  2000,
      creative:   { productId: listing.product_id, operation: 'text_generation' },
    })

    const parsed = safeParseJson(out.text)
    if (!parsed) throw new BadRequestException('LLM retornou JSON inválido na variante')
    const variant = {
      title:       String(parsed.title ?? '').trim(),
      description: String(parsed.description ?? '').trim(),
      bullets:     Array.isArray(parsed.bullets) ? (parsed.bullets as unknown[]).map(String) : [],
    }

    const merged = { ...(listing.marketplace_variants ?? {}), [target]: variant }
    const { data, error } = await supabaseAdmin
      .from('creative_listings')
      .update({ marketplace_variants: merged, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', listingId)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`createVariant.update: ${error.message}`)
    return data as CreativeListing
  }

  // ════════════════════════════════════════════════════════════════════════
  // USAGE
  // ════════════════════════════════════════════════════════════════════════

  /** Resumo de uso/custo do org no escopo de Creative — agrega ai_usage_log
   * filtrando creative_product_id NOT NULL. */
  async getUsage(orgId: string, opts: { sinceDays?: number } = {}): Promise<{
    total_cost_usd:    number
    total_operations:  number
    by_operation:      Record<string, { count: number; cost_usd: number }>
    by_product_top10:  Array<{ product_id: string | null; product_name: string | null; count: number; cost_usd: number }>
  }> {
    const since = new Date(Date.now() - (opts.sinceDays ?? 30) * 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await supabaseAdmin
      .from('ai_usage_log')
      .select('creative_product_id, creative_operation, cost_usd')
      .eq('organization_id', orgId)
      .gte('created_at', since)
      .not('creative_product_id', 'is', null)
      .limit(10_000)
    if (error) throw new BadRequestException(`getUsage: ${error.message}`)

    const rows = (data ?? []) as Array<{ creative_product_id: string | null; creative_operation: string | null; cost_usd: number | null }>
    const byOperation: Record<string, { count: number; cost_usd: number }> = {}
    const byProduct:   Record<string, { count: number; cost_usd: number }> = {}
    let totalCost = 0
    for (const r of rows) {
      const cost = Number(r.cost_usd ?? 0)
      totalCost += cost
      const op = r.creative_operation ?? 'unknown'
      const bucket = byOperation[op] ?? (byOperation[op] = { count: 0, cost_usd: 0 })
      bucket.count += 1
      bucket.cost_usd += cost
      if (r.creative_product_id) {
        const pb = byProduct[r.creative_product_id] ?? (byProduct[r.creative_product_id] = { count: 0, cost_usd: 0 })
        pb.count += 1
        pb.cost_usd += cost
      }
    }

    // Top 10 produtos com nome
    const productIds = Object.keys(byProduct)
    let nameMap = new Map<string, string>()
    if (productIds.length > 0) {
      const { data: names } = await supabaseAdmin
        .from('creative_products')
        .select('id, name')
        .in('id', productIds)
      nameMap = new Map((names ?? []).map((p: { id: string; name: string }) => [p.id, p.name]))
    }
    const topProducts = Object.entries(byProduct)
      .sort(([, a], [, b]) => b.cost_usd - a.cost_usd)
      .slice(0, 10)
      .map(([pid, agg]) => ({
        product_id:   pid,
        product_name: nameMap.get(pid) ?? null,
        count:        agg.count,
        cost_usd:     round6(agg.cost_usd),
      }))

    return {
      total_cost_usd:   round6(totalCost),
      total_operations: rows.length,
      by_operation:     mapValues(byOperation, v => ({ count: v.count, cost_usd: round6(v.cost_usd) })),
      by_product_top10: topProducts,
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function safeParseJson(text: string): Record<string, unknown> | null {
  // Tolera markdown ```json ... ``` envolvendo o output.
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
  try {
    const parsed = JSON.parse(cleaned)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function normalizeListingFields(parsed: Record<string, unknown>): {
  title:                    string
  subtitle:                 string | null
  description:              string
  bullets:                  string[]
  technical_sheet:          Record<string, unknown>
  keywords:                 string[]
  search_tags:              string[]
  suggested_category:       string | null
  faq:                      Array<{ q: string; a: string }>
  commercial_differentials: string[]
} {
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? (v as unknown[]).map(x => String(x)).filter(s => s.length > 0) : []
  const faqRaw = Array.isArray(parsed.faq) ? (parsed.faq as unknown[]) : []
  const faq = faqRaw
    .map(item => {
      if (!item || typeof item !== 'object') return null
      const obj = item as Record<string, unknown>
      const q = String(obj.q ?? obj.question ?? '').trim()
      const a = String(obj.a ?? obj.answer  ?? '').trim()
      return q && a ? { q, a } : null
    })
    .filter((x): x is { q: string; a: string } => x !== null)

  return {
    title:                    String(parsed.title ?? '').trim() || 'Título não gerado',
    subtitle:                 parsed.subtitle ? String(parsed.subtitle).trim() : null,
    description:              String(parsed.description ?? '').trim() || 'Descrição não gerada',
    bullets:                  arr(parsed.bullets),
    technical_sheet:          (parsed.technical_sheet && typeof parsed.technical_sheet === 'object')
                                ? parsed.technical_sheet as Record<string, unknown>
                                : {},
    keywords:                 arr(parsed.keywords),
    search_tags:              arr(parsed.search_tags),
    suggested_category:       parsed.suggested_category ? String(parsed.suggested_category).trim() : null,
    faq,
    commercial_differentials: arr(parsed.commercial_differentials),
  }
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}

function mapValues<V, R>(obj: Record<string, V>, fn: (v: V) => R): Record<string, R> {
  const out: Record<string, R> = {}
  for (const k of Object.keys(obj)) out[k] = fn(obj[k])
  return out
}

/** Parse de array JSON de prompts retornado pelo LLM. Tolerante a wrapper
 *  markdown (```json ... ```). Pareado com parsePromptsArray dos pipelines. */
function parsePromptsArrayJson(text: string, expected: number): string[] {
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
  let parsed: unknown
  try { parsed = JSON.parse(cleaned) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return parsed
    .map(p => typeof p === 'string' ? p.trim() : '')
    .filter(p => p.length > 0)
    .slice(0, expected)
}
