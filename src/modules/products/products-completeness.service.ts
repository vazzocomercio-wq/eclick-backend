import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { MlCategoryRequirementsService, type MlRequiredAttribute } from './ml-category-requirements.service'

/**
 * F2 (sessão 2026-05-14) — Avalia se um produto está "apto a anunciar" no ML.
 *
 * Duas camadas:
 *
 * 1. UNIVERSAL (independente de categoria):
 *    - sku, name (mínimo absoluto)
 *    - cost_price, my_price (margem/preço)
 *    - brand (ML praticamente sempre exige)
 *    - weight_kg + dimensões (frete)
 *    - photo_urls com ≥ 1 imagem
 *    - description ≥ 80 chars
 *    - category_ml_id (sem isso, não dá pra checar camada 2)
 *
 * 2. ML-CATEGORY (dinâmica por categoria):
 *    - Atributos com `tags.required` ou `tags.catalog_required` na resposta
 *      de `/categories/{id}/attributes`
 *    - Verifica `product.attributes[attr_id]` preenchido
 *    - Se attribute tem `values` (enum), aceita match por id ou name (CI)
 *
 * Retorna:
 *   ready_for_ml: bool        — pode criar listing ML sem rejeição
 *   complete:     bool        — universal + ML attrs preenchidos
 *   missing_universal: []     — campos universais faltando
 *   missing_ml_attrs: [{ id, name }]  — attrs ML faltando
 */

export interface CompletenessResult {
  ready_for_ml:        boolean
  complete:            boolean
  missing_universal:   string[]
  missing_ml_attrs:    Array<{ id: string; name: string; catalog_required?: boolean }>
  total_required:      number
  total_filled:        number
  category_id?:        string | null
}

interface ProductForCheck {
  id?:               string
  sku?:              string | null
  name?:             string | null
  brand?:            string | null
  cost_price?:       number | null
  my_price?:         number | null
  price?:            number | null
  weight_kg?:        number | null
  width_cm?:         number | null
  length_cm?:        number | null
  height_cm?:        number | null
  photo_urls?:       string[] | null
  description?:      string | null
  category_ml_id?:   string | null
  gtin?:             string | null
  attributes?:       Record<string, unknown> | null
  ml_title?:         string | null
}

// Labels PT-BR para missing_universal
const UNIVERSAL_LABELS: Record<string, string> = {
  sku:           'SKU',
  name:          'Nome',
  brand:         'Marca',
  cost_price:    'Custo',
  my_price:      'Preço',
  weight_kg:     'Peso (kg)',
  width_cm:      'Largura',
  length_cm:     'Comprimento',
  height_cm:     'Altura',
  photo_urls:    'Pelo menos 1 foto',
  description:   'Descrição (≥80 chars)',
  category_ml_id: 'Categoria ML',
  ml_title:      'Título ML',
}

@Injectable()
export class ProductsCompletenessService {
  private readonly log = new Logger(ProductsCompletenessService.name)

  constructor(private readonly mlReq: MlCategoryRequirementsService) {}

  /** Avalia um único produto. */
  async evaluate(product: ProductForCheck): Promise<CompletenessResult> {
    const missingUniversal = this.checkUniversal(product)
    const missingMlAttrs   = await this.checkMlAttrs(product)
    const totalRequired    = this.countUniversal() + missingMlAttrs.length + this.countMlFilled(product, missingMlAttrs)
    const totalFilled      = (this.countUniversal() - missingUniversal.length) + this.countMlFilled(product, missingMlAttrs)

    return {
      ready_for_ml:      missingUniversal.length === 0 && missingMlAttrs.length === 0,
      complete:          missingUniversal.length === 0 && missingMlAttrs.length === 0,
      missing_universal: missingUniversal.map(k => UNIVERSAL_LABELS[k] ?? k),
      missing_ml_attrs:  missingMlAttrs.map(a => ({ id: a.id, name: a.name, catalog_required: a.catalog_required })),
      total_required:    totalRequired,
      total_filled:      totalFilled,
      category_id:       product.category_ml_id ?? null,
    }
  }

  /** Re-avalia produto pelo ID. Se ficou completo, remove tag 'cadastro_pendente'.
   *  Idempotente — pode chamar várias vezes sem efeito colateral. */
  async refreshAndCleanupTag(productId: string): Promise<{ removed_tag: boolean; result: CompletenessResult }> {
    const { data: product, error } = await supabaseAdmin
      .from('products')
      .select('id, sku, name, brand, cost_price, my_price, price, weight_kg, width_cm, length_cm, height_cm, photo_urls, description, category_ml_id, gtin, attributes, ml_title, tags, catalog_status')
      .eq('id', productId)
      .single()
    if (error || !product) {
      throw new Error(`refreshAndCleanupTag: produto ${productId} não encontrado`)
    }

    const result = await this.evaluate(product as ProductForCheck)
    const currentTags = Array.isArray((product as any).tags) ? (product as any).tags as string[] : []
    let removedTag = false

    if (result.complete && currentTags.includes('cadastro_pendente')) {
      const newTags = currentTags.filter(t => t !== 'cadastro_pendente')
      await supabaseAdmin
        .from('products')
        .update({
          tags:            newTags,
          catalog_status:  'ready',  // L1 toggle pra catálogo
          updated_at:      new Date().toISOString(),
        })
        .eq('id', productId)
      removedTag = true
    } else if (!result.complete && !currentTags.includes('cadastro_pendente')) {
      // produto ficou incompleto de novo (ex: deletou foto) — readiciona tag
      const newTags = [...currentTags, 'cadastro_pendente']
      await supabaseAdmin
        .from('products')
        .update({
          tags:            newTags,
          catalog_status:  'incomplete',
          updated_at:      new Date().toISOString(),
        })
        .eq('id', productId)
    }

    return { removed_tag: removedTag, result }
  }

  /** Bulk evaluation pra dashboard / cron — paraleliza fetch de categorias. */
  async evaluateBulk(orgId: string, limit = 500): Promise<{
    total:                number
    incomplete_count:     number
    by_missing:           Record<string, number>  // campo → quantos produtos faltam ele
    sample_incomplete:    Array<{ id: string; sku: string | null; name: string; missing: string[] }>
  }> {
    const { data: products, error } = await supabaseAdmin
      .from('products')
      .select('id, sku, name, brand, cost_price, my_price, price, weight_kg, width_cm, length_cm, height_cm, photo_urls, description, category_ml_id, gtin, attributes, ml_title, tags')
      .eq('organization_id', orgId)
      .or('tags.cs.{cadastro_pendente},catalog_status.eq.incomplete')
      .limit(limit)

    if (error) throw new Error(error.message)
    const rows = (products ?? []) as ProductForCheck[]

    const byMissing: Record<string, number> = {}
    const sample: Array<{ id: string; sku: string | null; name: string; missing: string[] }> = []
    let incomplete = 0

    // Pré-carrega required attrs em batch
    const categoryIds = [...new Set(rows.map(p => p.category_ml_id).filter((c): c is string => !!c))]
    const catMap = await this.mlReq.getRequiredAttrsBulk(categoryIds)

    for (const p of rows) {
      const missingUniversal = this.checkUniversal(p)
      const requiredAttrs = p.category_ml_id ? (catMap.get(p.category_ml_id) ?? []) : []
      const missingMl = this.compareMlAttrs(p.attributes ?? {}, requiredAttrs)

      const allMissing = [
        ...missingUniversal.map(k => UNIVERSAL_LABELS[k] ?? k),
        ...missingMl.map(a => a.name),
      ]

      if (allMissing.length > 0) {
        incomplete++
        for (const m of allMissing) {
          byMissing[m] = (byMissing[m] ?? 0) + 1
        }
        if (sample.length < 20) {
          sample.push({
            id:      p.id ?? '',
            sku:     p.sku ?? null,
            name:    p.name ?? '',
            missing: allMissing,
          })
        }
      }
    }

    return {
      total:             rows.length,
      incomplete_count:  incomplete,
      by_missing:        byMissing,
      sample_incomplete: sample,
    }
  }

  // ── private ────────────────────────────────────────────────────────────────

  private checkUniversal(p: ProductForCheck): string[] {
    const missing: string[] = []
    if (!p.sku || String(p.sku).trim() === '') missing.push('sku')
    if (!p.name || String(p.name).trim() === '') missing.push('name')
    if (!p.brand || String(p.brand).trim() === '') missing.push('brand')
    if (p.cost_price == null || Number(p.cost_price) <= 0) missing.push('cost_price')
    const price = p.my_price ?? p.price
    if (price == null || Number(price) <= 0) missing.push('my_price')
    if (p.weight_kg == null || Number(p.weight_kg) <= 0) missing.push('weight_kg')
    if (p.width_cm == null || Number(p.width_cm) <= 0) missing.push('width_cm')
    if (p.length_cm == null || Number(p.length_cm) <= 0) missing.push('length_cm')
    if (p.height_cm == null || Number(p.height_cm) <= 0) missing.push('height_cm')
    const photos = Array.isArray(p.photo_urls) ? p.photo_urls : []
    if (photos.filter(u => typeof u === 'string' && u.trim() !== '').length === 0) missing.push('photo_urls')
    if (!p.description || String(p.description).trim().length < 80) missing.push('description')
    if (!p.category_ml_id || String(p.category_ml_id).trim() === '') missing.push('category_ml_id')
    if (!p.ml_title || String(p.ml_title).trim() === '') missing.push('ml_title')
    return missing
  }

  private countUniversal(): number {
    return Object.keys(UNIVERSAL_LABELS).length
  }

  private async checkMlAttrs(p: ProductForCheck): Promise<MlRequiredAttribute[]> {
    if (!p.category_ml_id) return []
    const required = await this.mlReq.getRequiredAttrs(p.category_ml_id)
    return this.compareMlAttrs(p.attributes ?? {}, required)
  }

  private compareMlAttrs(productAttrs: Record<string, unknown> | null, required: MlRequiredAttribute[]): MlRequiredAttribute[] {
    const attrs = productAttrs ?? {}
    const missing: MlRequiredAttribute[] = []
    for (const req of required) {
      const v = attrs[req.id]
      if (this.isAttrEmpty(v)) missing.push(req)
    }
    return missing
  }

  private isAttrEmpty(v: unknown): boolean {
    if (v == null) return true
    if (typeof v === 'string') return v.trim() === ''
    if (typeof v === 'number') return !Number.isFinite(v)
    if (Array.isArray(v)) return v.length === 0
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>
      // ML attributes format: { value_id, value_name } ou { value_struct }
      const hasValue = (o.value_id != null && String(o.value_id).trim() !== '') ||
                       (o.value_name != null && String(o.value_name).trim() !== '') ||
                       (o.value_struct != null)
      return !hasValue
    }
    return false
  }

  private countMlFilled(p: ProductForCheck, missingMl: MlRequiredAttribute[]): number {
    if (!p.category_ml_id) return 0
    // Aproximação: total required = filled + missing
    return missingMl.length
  }
}
