/**
 * F6 Sprint 2 — Resolução de templates.
 *
 * Responsabilidades:
 *   1. matchTemplateForProduct(orgId, product_id) → escolhe template ideal
 *      seguindo prioridade: category_ml_ids match > is_default > most recent.
 *   2. resolveReferencesForPosition(orgId, product, briefing, templatePosition)
 *      → resolve refs (fixos + dinâmicos + produto + logo) com signed URLs.
 *   3. previewTemplate(orgId, templateId, product_id, [briefing_id])
 *      → renderiza prompts com {vars} substituídas + refs prontas pra UI.
 *
 * Usa adminClient (service_role) — Fase 2.3 vai consumir esse service
 * a partir do pipeline interno (sem JWT do user).
 *
 * Não persiste nada — read-only do DB, retorna estruturas prontas.
 */

import {
  Injectable, Logger, BadRequestException, NotFoundException,
} from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import {
  CreativePromptTemplatesService,
  type CreativeImagePromptTemplate,
} from './creative-prompt-templates.service'
import {
  CreativeReferencesService,
  type CreativeReferenceImage,
} from './creative-references.service'
import type {
  TemplatePositionDto, AspectRatio,
} from './dto/template-position.dto'
import type {
  PreviewTemplateDto, ResolvedPositionPreview,
} from './dto/preview-template.dto'

// ── Helpers exportáveis ─────────────────────────────────────────────────────

/**
 * Remove prefixos "Cor principal:", "Secundária:" etc. que a análise IA vazoa
 * no campo `creative_products.color`. Fica fora da classe pra ser fácil de
 * testar isoladamente.
 *
 * Versão agressiva (Fase 2.5): aplica em qualquer posição do token (não só
 * início), remove parênteses descritivos tipo "(estrutura metálica)", e
 * colapsa whitespace múltiplo. Trata também o caso de prefixo no MEIO do
 * token (ex.: "champagne fosco; Secundária: branco" quebrou em "/" antes
 * do "Secundária:" — o resíduo ainda contém o prefixo, e a regex global
 * agora pega).
 */
export function stripColorPrefix(s: string | null | undefined): string {
  if (!s) return ''
  return s
    .replace(/(?:^|\s|;|,)\s*(cor principal|cor secund[áa]ria|secund[áa]ria|principal|prim[áa]ria)\s*:\s*/gi, ' ')
    .trim()
}

/** Normaliza um token de cor: tira prefixos, parênteses descritivos e whitespace. */
export function normalizeColorToken(s: string | null | undefined): string {
  if (!s) return ''
  return stripColorPrefix(s)
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── Types locais (espelham creative.service mas evitam circular import) ─────

/**
 * Shape mínimo de produto exigido pra resolução de variáveis e refs.
 * Compatível com CreativeProduct (creative.service) — pipeline pode passar
 * direto sem adaptação. Exportado pra pipeline ter type-check.
 */
export interface ProductRow {
  id:                       string
  organization_id:          string
  name:                     string
  category:                 string
  brand:                    string | null
  color:                    string | null
  material:                 string | null
  differentials:            string[] | null
  target_audience:          string | null
  dimensions:               Record<string, unknown> | null
  main_image_storage_path:  string
  ai_analysis:              Record<string, unknown> | null
  /** Vínculo opcional com catálogo — usado pra pegar category_ml_id pro match. */
  product_id:               string | null
}

/** Subset do CreativeBriefing requerido pra resolução. */
export interface BriefingRow {
  id:                  string
  product_id:          string
  environments:        string[] | null
  custom_environment:  string | null
  use_logo:            boolean
  logo_url:            string | null
  logo_storage_path:   string | null
}

interface CatalogProductRow {
  id:               string
  category_ml_id:   string | null
}

/**
 * Item de referência resolvido. Quando `signed_url=null`, o caller precisa
 * assinar via `signStorageUrl(storage_bucket, storage_path)` JIT (modo path).
 * Quando `signed_url` populado, está pronto pra UI (modo signed).
 */
export interface ReferenceResolved {
  /** Identificador estável: 'product:<uuid>' | 'logo:<briefingId>' | DB uuid (refs). */
  id:             string
  name:           string
  storage_bucket: 'creative' | 'creative-references'
  storage_path:   string
  /** Populado em modo signed (default). Null em modo path (pipeline). */
  signed_url:     string | null
  source:         ResolvedPositionPreview['references'][number]['source']
  /** Real DB id (creative_reference_images.id) ou null pra product_main/brand_logo. */
  reference_id:   string | null
}

/** @deprecated Use `ReferenceResolved`. Mantido pra compat das call sites antigas. */
export interface ReferenceWithSignedUrl {
  id:           string
  name:         string
  storage_path: string
  signed_url:   string
  source:       ResolvedPositionPreview['references'][number]['source']
}

export interface MatchedTemplate {
  template:        CreativeImagePromptTemplate
  match_reason:    'category_exact' | 'org_default' | 'most_recent' | 'none'
  matched_category_ml_id?: string
}

@Injectable()
export class CreativeTemplateResolutionService {
  private readonly logger = new Logger(CreativeTemplateResolutionService.name)

  constructor(
    private readonly templates:  CreativePromptTemplatesService,
    private readonly references: CreativeReferencesService,
  ) {}

  // ════════════════════════════════════════════════════════════════════════
  // 1. Match template for product
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Retorna o melhor template pra um produto. Prioridade:
   *   1. Template com category_ml_ids que cubra a categoria do catalog product (se vinculado)
   *   2. Template is_default=true da org
   *   3. Template mais recente da org
   *   4. null se org não tem nenhum template
   */
  async matchTemplateForProduct(orgId: string, productId: string): Promise<MatchedTemplate | null> {
    const product = await this.loadProduct(orgId, productId)
    const catalog = product.product_id ? await this.loadCatalog(orgId, product.product_id) : null
    const categoryMlId = catalog?.category_ml_id ?? null

    const templates = await this.templates.list(orgId)
    if (templates.length === 0) return null

    // 1. Category exact
    if (categoryMlId) {
      const byCategory = templates.find(t => t.category_ml_ids.includes(categoryMlId))
      if (byCategory) {
        return { template: byCategory, match_reason: 'category_exact', matched_category_ml_id: categoryMlId }
      }
    }

    // 2. Org default
    const byDefault = templates.find(t => t.is_default)
    if (byDefault) return { template: byDefault, match_reason: 'org_default' }

    // 3. Most recent (list já vem ordenado por is_default desc, created_at desc)
    return { template: templates[0], match_reason: 'most_recent' }
  }

  // ════════════════════════════════════════════════════════════════════════
  // 2. Preview template — main public entry point
  // ════════════════════════════════════════════════════════════════════════

  async previewTemplate(orgId: string, templateId: string, dto: PreviewTemplateDto): Promise<{
    template_id: string
    product_id:  string
    briefing_id: string | null
    positions:   ResolvedPositionPreview[]
  }> {
    if (!dto?.product_id) throw new BadRequestException('product_id obrigatório')
    const template = await this.templates.getById(orgId, templateId)
    const product = await this.loadProduct(orgId, dto.product_id)

    // Briefing opcional: usa o passado, ou o ativo do produto, ou null
    let briefing: BriefingRow | null = null
    if (dto.briefing_id) {
      briefing = await this.loadBriefing(orgId, dto.briefing_id)
      if (briefing.product_id !== product.id) {
        throw new BadRequestException(`briefing_id ${dto.briefing_id} pertence a outro product`)
      }
    } else {
      briefing = await this.loadActiveBriefing(orgId, product.id)
    }

    const wantedPositions = dto.positions && dto.positions.length > 0
      ? new Set(dto.positions)
      : null
    const filtered = wantedPositions
      ? template.positions.filter(p => wantedPositions.has(p.position))
      : template.positions

    const resolved: ResolvedPositionPreview[] = []
    for (const tp of filtered) {
      resolved.push(await this.resolvePosition(orgId, product, briefing, tp))
    }

    return {
      template_id: template.id,
      product_id:  product.id,
      briefing_id: briefing?.id ?? null,
      positions:   resolved,
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // 3. Resolve references for a single position
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Resolve refs pra uma TemplatePosition + um produto + (opcional) briefing.
   * Ordem de prioridade:
   *   1. use_reference_ids[] — refs fixos (curated ou da org)
   *   2. reference_match.by_position_default — refs que servem essa position
   *   3. reference_match.by_category        — refs da mesma categoria do produto
   *   4. reference_match.by_tags            — refs com overlap de tags
   *   5. use_product_reference              — appende a imagem principal do produto
   *   6. use_brand_logo                     — appende o logo do briefing
   *
   * Sempre dedup por id. Respeita limit (default 3, hard cap 6) APENAS
   * pros itens 2-4 (refs do banco). Items 1, 5, 6 sempre incluem (são explícitos).
   */
  async resolveReferencesForPosition(
    orgId: string,
    product: ProductRow,
    briefing: BriefingRow | null,
    position: TemplatePositionDto,
    opts: { returnPaths?: boolean } = {},
  ): Promise<{ refs: ReferenceResolved[]; warnings: string[] }> {
    const returnPaths = opts.returnPaths === true

    /** Helper interno: assina (modo signed) ou retorna null (modo path).
     *  Modo path NUNCA hita o Storage — economiza ~5 chamadas em cada gerar-prompts. */
    const maybeSign = async (
      bucket: 'creative' | 'creative-references',
      path:   string,
    ): Promise<string | null> => {
      if (returnPaths) return null
      if (bucket === 'creative-references') return this.references.signRead(path)
      // 'creative' (produto/logo) — pipeline antigo já usa 1h TTL
      return this.signProductImage(path)
    }

    const out: ReferenceResolved[] = []
    const seen = new Set<string>()
    const warnings: string[] = []
    const catalog = product.product_id ? await this.loadCatalog(orgId, product.product_id) : null
    const categoryMlId = catalog?.category_ml_id ?? null

    // 1. Fixed IDs
    if (position.use_reference_ids && position.use_reference_ids.length > 0) {
      const fixedRows = await this.loadReferencesByIds(orgId, position.use_reference_ids)
      for (const r of fixedRows) {
        if (seen.has(r.id)) continue
        seen.add(r.id)
        try {
          const url = await maybeSign('creative-references', r.storage_path)
          out.push({
            id:             r.id,
            name:           r.name,
            storage_bucket: 'creative-references',
            storage_path:   r.storage_path,
            signed_url:     url,
            source:         'fixed_id',
            reference_id:   r.id,
          })
        } catch (e) {
          warnings.push(`ref ${r.id} (${r.name}): ${(e as Error).message}`)
        }
      }
      // IDs não encontrados → warning
      const foundIds = new Set(fixedRows.map(r => r.id))
      for (const id of position.use_reference_ids) {
        if (!foundIds.has(id)) warnings.push(`use_reference_ids[${id}]: ref não encontrada ou inativa`)
      }
    }

    // 2-4. Dynamic matching com limit
    const limit = Math.max(1, Math.min(6, position.reference_match?.limit ?? 3))
    const remainingSlots = () => limit - out.filter(r =>
      r.source === 'position_default' || r.source === 'category_match' || r.source === 'tag_match',
    ).length

    const pushDynamic = async (rows: CreativeReferenceImage[], source: ReferenceResolved['source']) => {
      for (const r of rows) {
        if (seen.has(r.id)) continue
        seen.add(r.id)
        try {
          const url = await maybeSign('creative-references', r.storage_path)
          out.push({
            id:             r.id,
            name:           r.name,
            storage_bucket: 'creative-references',
            storage_path:   r.storage_path,
            signed_url:     url,
            source,
            reference_id:   r.id,
          })
        } catch {
          continue // ref inacessível — pula silently
        }
        if (remainingSlots() === 0) break
      }
    }

    if (position.reference_match?.by_position_default && remainingSlots() > 0) {
      const rows = await this.queryDynamicRefs(orgId, {
        position: position.position,
        category_ml_id: categoryMlId,
      }, remainingSlots())
      await pushDynamic(rows, 'position_default')
    }

    if (position.reference_match?.by_category && categoryMlId && remainingSlots() > 0) {
      const rows = await this.queryDynamicRefs(orgId, { category_ml_id: categoryMlId }, remainingSlots())
      await pushDynamic(rows, 'category_match')
    }

    if (position.reference_match?.by_tags && position.reference_match.by_tags.length > 0 && remainingSlots() > 0) {
      const rows = await this.queryDynamicRefs(orgId, { tags: position.reference_match.by_tags }, remainingSlots())
      await pushDynamic(rows, 'tag_match')
    }

    // 5. Product main image (bucket 'creative')
    if (position.use_product_reference) {
      try {
        const url = await maybeSign('creative', product.main_image_storage_path)
        out.push({
          id:             `product:${product.id}`,
          name:           product.name,
          storage_bucket: 'creative',
          storage_path:   product.main_image_storage_path,
          signed_url:     url,
          source:         'product_main',
          reference_id:   null,
        })
      } catch (e) {
        warnings.push(`use_product_reference: falha ao assinar imagem do produto: ${(e as Error).message}`)
      }
    }

    // 6. Brand logo (bucket 'creative')
    if (position.use_brand_logo) {
      if (!briefing) {
        warnings.push('use_brand_logo: nenhum briefing fornecido — logo não disponível')
      } else if (!briefing.use_logo || !briefing.logo_storage_path) {
        warnings.push('use_brand_logo: briefing.use_logo=false ou logo_storage_path vazio')
      } else {
        try {
          const url = await maybeSign('creative', briefing.logo_storage_path)
          out.push({
            id:             `logo:${briefing.id}`,
            name:           'Logo da marca',
            storage_bucket: 'creative',
            storage_path:   briefing.logo_storage_path,
            signed_url:     url,
            source:         'brand_logo',
            reference_id:   null,
          })
        } catch (e) {
          warnings.push(`use_brand_logo: falha ao assinar logo: ${(e as Error).message}`)
        }
      }
    }

    return { refs: out, warnings }
  }

  /**
   * Assina um path no bucket informado. Usa o cache do CreativeReferencesService
   * pra `creative-references` (50min TTL); pra `creative` faz sign direto
   * (sem cache — UI consome assets do `creative` por outras rotas com cache próprio).
   *
   * Exposto pra pipeline assinar JIT a partir das refs persistidas em
   * generation_metadata sem regerar o cache toda vez.
   */
  async signStorageUrl(
    bucket: 'creative' | 'creative-references',
    storagePath: string,
    ttlSec = 3600,
  ): Promise<string> {
    if (bucket === 'creative-references') {
      return this.references.signRead(storagePath) // já tem cache TTL 50min
    }
    const { data, error } = await supabaseAdmin
      .storage
      .from('creative')
      .createSignedUrl(storagePath, ttlSec)
    if (error || !data?.signedUrl) {
      throw new BadRequestException(`signStorageUrl(${bucket}, ${storagePath}): ${error?.message ?? 'falhou'}`)
    }
    return data.signedUrl
  }

  // ════════════════════════════════════════════════════════════════════════
  // 4. Variable interpolation
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Substitui {vars} em um template de string. Vars não conhecidas/vazias
   * são substituídas por string vazia (não deixa "{undefined_var}" vazado
   * no prompt final).
   */
  interpolate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (_match, name) => {
      return Object.prototype.hasOwnProperty.call(vars, name) ? (vars[name] ?? '') : ''
    })
  }

  /**
   * Constrói o dicionário de variáveis pra um produto + briefing + position.
   * Exposto pra debug (preview retorna isso) e usado internamente em resolvePosition.
   */
  buildVariables(
    product: ProductRow,
    briefing: BriefingRow | null,
    position: TemplatePositionDto,
  ): Record<string, string> {
    const a = (product.ai_analysis ?? {}) as Record<string, unknown>
    const colorRaw = product.color ?? (typeof a.detected_color === 'string' ? a.detected_color : '')
    const [primaryColor, secondaryColor] = this.splitColors(colorRaw)
    const material = product.material ?? (typeof a.detected_material === 'string' ? a.detected_material : '')
    const keyParts = Array.isArray(a.key_parts) ? (a.key_parts as unknown[]).filter(p => typeof p === 'string') : []
    const usageCtx = Array.isArray(a.possible_uses) ? (a.possible_uses as unknown[]).filter(p => typeof p === 'string') : []
    const ambientLabel = position.ambient_hint ?? briefing?.environments?.[0] ?? briefing?.custom_environment ?? ''

    return {
      product_name:             product.name ?? '',
      material:                 material || '',
      primary_color:            primaryColor,
      secondary_color:          secondaryColor,
      dimensions:               this.formatDimensions(product.dimensions),
      category_label:           product.category ?? '',
      brand_name:               product.brand ?? '',
      detected_parts:           (keyParts as string[]).join(', '),
      usage_contexts:           (usageCtx as string[]).join(', '),
      target_audience:          product.target_audience ?? '',
      commercial_differentials: (product.differentials ?? []).join(', '),
      ambient_label:            ambientLabel,
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Internals
  // ════════════════════════════════════════════════════════════════════════

  private async resolvePosition(
    orgId: string,
    product: ProductRow,
    briefing: BriefingRow | null,
    tp: TemplatePositionDto,
  ): Promise<ResolvedPositionPreview> {
    const vars = this.buildVariables(product, briefing, tp)
    const prompt_resolved = this.interpolate(tp.prompt_template, vars)
    const negative_prompt = tp.negative_prompt ? this.interpolate(tp.negative_prompt, vars) : undefined
    const { refs, warnings } = await this.resolveReferencesForPosition(orgId, product, briefing, tp)
    const aspect_ratio: AspectRatio = tp.aspect_ratio ?? '1:1'

    return {
      position:           tp.position,
      name:               tp.name,
      prompt_template:    tp.prompt_template,
      prompt_resolved,
      negative_prompt,
      aspect_ratio,
      // Preview SEMPRE roda em modo signed (returnPaths=false default), então
      // signed_url está populado. Defensivo: filtra entradas sem URL.
      references:         refs
        .filter(r => r.signed_url !== null)
        .map(r => ({
          id:           r.id,
          name:         r.name,
          storage_path: r.storage_path,
          signed_url:   r.signed_url as string,
          source:       r.source,
        })),
      variables_resolved: vars,
      warnings,
    }
  }

  private async loadProduct(orgId: string, id: string): Promise<ProductRow> {
    const { data, error } = await supabaseAdmin
      .from('creative_products')
      .select('id, organization_id, name, category, brand, color, material, differentials, target_audience, dimensions, main_image_storage_path, ai_analysis, product_id')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new BadRequestException(`loadProduct: ${error.message}`)
    if (!data) throw new NotFoundException('produto não encontrado')
    return data as ProductRow
  }

  private async loadCatalog(orgId: string, catalogProductId: string): Promise<CatalogProductRow | null> {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('id, category_ml_id')
      .eq('id', catalogProductId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) {
      this.logger.warn(`loadCatalog ${catalogProductId}: ${error.message}`)
      return null
    }
    return (data as CatalogProductRow | null) ?? null
  }

  private async loadBriefing(orgId: string, briefingId: string): Promise<BriefingRow> {
    const { data, error } = await supabaseAdmin
      .from('creative_briefings')
      .select('id, product_id, environments, custom_environment, use_logo, logo_url, logo_storage_path, organization_id')
      .eq('id', briefingId)
      .maybeSingle()
    if (error) throw new BadRequestException(`loadBriefing: ${error.message}`)
    if (!data) throw new NotFoundException('briefing não encontrado')
    const b = data as BriefingRow & { organization_id: string }
    if (b.organization_id !== orgId) throw new BadRequestException('briefing pertence a outra org')
    return b
  }

  private async loadActiveBriefing(orgId: string, productId: string): Promise<BriefingRow | null> {
    const { data, error } = await supabaseAdmin
      .from('creative_briefings')
      .select('id, product_id, environments, custom_environment, use_logo, logo_url, logo_storage_path')
      .eq('organization_id', orgId)
      .eq('product_id', productId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) {
      this.logger.warn(`loadActiveBriefing: ${error.message}`)
      return null
    }
    return (data as BriefingRow | null) ?? null
  }

  private async loadReferencesByIds(orgId: string, ids: string[]): Promise<CreativeReferenceImage[]> {
    if (ids.length === 0) return []
    // service_role bypassa RLS — filtra manualmente curated OR org's own
    const { data, error } = await supabaseAdmin
      .from('creative_reference_images')
      .select('*')
      .in('id', ids)
      .eq('is_active', true)
      .or(`organization_id.eq.${orgId},is_curated.eq.true`)
    if (error) throw new BadRequestException(`loadReferencesByIds: ${error.message}`)
    return (data ?? []) as CreativeReferenceImage[]
  }

  /**
   * Query dinâmica pra refs. Combina critérios com AND.
   * Mistura org's own + curated (visíveis a todos).
   */
  private async queryDynamicRefs(
    orgId: string,
    filters: {
      position?:        number
      category_ml_id?:  string | null
      tags?:            string[]
    },
    limit: number,
  ): Promise<CreativeReferenceImage[]> {
    if (limit <= 0) return []
    let q = supabaseAdmin
      .from('creative_reference_images')
      .select('*')
      .eq('is_active', true)
      .or(`organization_id.eq.${orgId},is_curated.eq.true`)
      .order('is_curated', { ascending: false }) // prioriza curated
      .order('created_at', { ascending: false })
      .limit(limit * 2) // pega extra pra dedup

    if (filters.position !== undefined) {
      q = q.contains('default_for_positions', [filters.position])
    }
    if (filters.category_ml_id) {
      q = q.contains('category_ml_ids', [filters.category_ml_id])
    }
    if (filters.tags && filters.tags.length > 0) {
      q = q.overlaps('tags', filters.tags)
    }

    const { data, error } = await q
    if (error) {
      this.logger.warn(`queryDynamicRefs: ${error.message}`)
      return []
    }
    return ((data ?? []) as CreativeReferenceImage[]).slice(0, limit)
  }

  /**
   * Assina URL do bucket `creative` (não `creative-references`) — usado pra
   * imagem principal do produto e logo da marca, que ficam no bucket original.
   */
  private async signProductImage(storagePath: string): Promise<string> {
    const { data, error } = await supabaseAdmin
      .storage
      .from('creative')
      .createSignedUrl(storagePath, 60 * 60)
    if (error || !data?.signedUrl) {
      throw new BadRequestException(`signProductImage: ${error?.message ?? 'falhou'}`)
    }
    return data.signedUrl
  }

  // ── Pure helpers ─────────────────────────────────────────────────────────

  /**
   * Quebra string de cor (vazoada da análise IA) em [primary, secondary].
   *
   * Fase 2.5 — agressiva: separa por TODOS os splitters de uma vez (não só
   * o primeiro que casa), aplica `normalizeColorToken` (tira prefixos
   * "Cor principal:" / "Secundária:" + parênteses descritivos) e descarta
   * tokens vazios.
   *
   * Exemplos:
   *   "Cor principal: dourado/champagne fosco (estrutura metálica); Secundária: branco leitoso (globo de vidro)"
   *     → ["dourado", "champagne fosco", "branco leitoso"] (3 tokens)
   *     → primary="dourado", secondary="champagne fosco" (terceiro é descartado por enquanto)
   *   "Branco e cinza" → ["Branco", "cinza"]
   *   "Branco/Preto"   → ["Branco", "Preto"]
   *   "Branco fosco"   → ["Branco fosco", ""]
   */
  private splitColors(raw: string): [string, string] {
    if (!raw) return ['', '']
    const tokens = raw
      .split(/[;,/+]|\s+(?:e|and)\s+/i)
      .map(s => normalizeColorToken(s))
      .filter(Boolean)
    return [tokens[0] ?? '', tokens[1] ?? '']
  }

  /**
   * { altura: "15cm", largura: "30cm" } → "altura: 15cm, largura: 30cm"
   * {} ou null → ""
   */
  private formatDimensions(d: Record<string, unknown> | null | undefined): string {
    if (!d) return ''
    const entries = Object.entries(d).filter(([_, v]) => v !== undefined && v !== null && v !== '')
    if (entries.length === 0) return ''
    return entries.map(([k, v]) => `${k}: ${String(v)}`).join(', ')
  }
}
