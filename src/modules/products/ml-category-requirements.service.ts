import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'

/**
 * F2 (sessão 2026-05-14) — Wrapper sobre o cache existente `ml_category_attributes`.
 *
 * Foco: extrair APENAS atributos `tags.required === true` ou `tags.catalog_required`
 * pra cada categoria. Usado por `ProductsCompletenessService` pra decidir se
 * um produto está "apto a anunciar" no ML.
 *
 * Cache: TTL 7 dias (mesma janela usada por `ml-quality`). Em miss, busca
 * endpoint PÚBLICO `/categories/{id}/attributes` (não precisa token — o ML
 * libera leitura de meta-dados de categoria sem auth).
 */

export interface MlRequiredAttribute {
  id:                 string
  name:               string
  value_type?:        string         // string | number | boolean | list | number_unit
  value_max_length?:  number
  values?:            Array<{ id: string; name: string }>  // se list, valores válidos
  required:           boolean        // tags.required
  catalog_required?:  boolean        // tags.catalog_required
  allows_variations?: boolean        // tags.allow_variations
  hint?:              string         // hint pro user preencher
}

const ML_BASE = 'https://api.mercadolibre.com'
const CACHE_TTL_DAYS = 7

@Injectable()
export class MlCategoryRequirementsService {
  private readonly log = new Logger(MlCategoryRequirementsService.name)
  private memoryCache = new Map<string, { attrs: MlRequiredAttribute[]; until: number }>()

  constructor(private readonly ml: MercadolivreService) {}

  /**
   * Retorna atributos required + recomendados (catalog_required) da categoria.
   * Ordem: required primeiro, depois catalog_required. Limitado a 50.
   */
  async getRequiredAttrs(categoryId: string): Promise<MlRequiredAttribute[]> {
    if (!categoryId || !categoryId.startsWith('MLB')) return []

    // 1) memoria de processo
    const mem = this.memoryCache.get(categoryId)
    if (mem && mem.until > Date.now()) return mem.attrs

    // 2) cache em DB
    const cached = await this.fromCache(categoryId)
    if (cached) {
      this.memoryCache.set(categoryId, { attrs: cached, until: Date.now() + 60 * 60_000 })
      return cached
    }

    // 3) fetch do ML (endpoint público — sem auth)
    const fresh = await this.fetchFromMl(categoryId)
    if (fresh) {
      await this.saveToCache(categoryId, fresh.raw, fresh.totalAttrs, fresh.totalRequired)
      this.memoryCache.set(categoryId, { attrs: fresh.parsed, until: Date.now() + 60 * 60_000 })
      return fresh.parsed
    }

    return []
  }

  /**
   * Bulk: pega required attrs de várias categorias de uma vez (paralelo
   * com limite de 5 concorrentes). Útil pro completeness em batch.
   */
  async getRequiredAttrsBulk(categoryIds: string[]): Promise<Map<string, MlRequiredAttribute[]>> {
    const out = new Map<string, MlRequiredAttribute[]>()
    const unique = [...new Set(categoryIds.filter(c => c?.startsWith('MLB')))]
    const CONCURRENCY = 5

    for (let i = 0; i < unique.length; i += CONCURRENCY) {
      const chunk = unique.slice(i, i + CONCURRENCY)
      const results = await Promise.all(chunk.map(c => this.getRequiredAttrs(c).catch(() => [] as MlRequiredAttribute[])))
      chunk.forEach((cat, idx) => out.set(cat, results[idx]))
    }
    return out
  }

  // ── private ────────────────────────────────────────────────────────────────

  private async fromCache(categoryId: string): Promise<MlRequiredAttribute[] | null> {
    const { data } = await supabaseAdmin
      .from('ml_category_attributes')
      .select('attributes, expires_at')
      .eq('ml_category_id', categoryId)
      .maybeSingle()
    if (!data) return null
    if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) return null
    const raw = Array.isArray(data.attributes) ? data.attributes : []
    return this.parseAttrs(raw)
  }

  private async fetchFromMl(categoryId: string): Promise<{ raw: unknown[]; parsed: MlRequiredAttribute[]; totalAttrs: number; totalRequired: number } | null> {
    try {
      const r = await axios.get<unknown[]>(`${ML_BASE}/categories/${encodeURIComponent(categoryId)}/attributes`, {
        timeout: 10000,
      })
      const arr = Array.isArray(r.data) ? r.data : []
      const parsed = this.parseAttrs(arr)
      const totalRequired = parsed.filter(a => a.required).length
      return { raw: arr, parsed, totalAttrs: arr.length, totalRequired }
    } catch (e) {
      this.log.warn(`[ml-cat-req] fetch ${categoryId} falhou: ${(e as Error).message}`)
      return null
    }
  }

  private async saveToCache(categoryId: string, raw: unknown[], total: number, totalRequired: number): Promise<void> {
    const expiresAt = new Date(Date.now() + CACHE_TTL_DAYS * 24 * 3600_000).toISOString()
    const { error } = await supabaseAdmin
      .from('ml_category_attributes')
      .upsert({
        ml_category_id:      categoryId,
        attributes:          raw,
        total_attributes:    total,
        required_attributes: totalRequired,
        last_fetched_at:     new Date().toISOString(),
        expires_at:          expiresAt,
        updated_at:          new Date().toISOString(),
      }, { onConflict: 'ml_category_id' })
    if (error) this.log.warn(`[ml-cat-req] save cache falhou: ${error.message}`)
  }

  private parseAttrs(raw: unknown[]): MlRequiredAttribute[] {
    if (!Array.isArray(raw)) return []
    const out: MlRequiredAttribute[] = []
    for (const a of raw) {
      const obj = a as Record<string, unknown>
      const id = String(obj.id ?? '')
      const name = String(obj.name ?? '')
      if (!id) continue

      const tags = (obj.tags ?? {}) as Record<string, unknown>
      const isRequired = tags.required === true || tags.catalog_required === true
      const isCatalogRequired = tags.catalog_required === true
      const allowsVariations = tags.allow_variations === true
      // Atributos "hidden" não devem ser exigidos do user — pula
      if (tags.hidden === true) continue
      // Foco em required / catalog_required / conditional_required
      if (!isRequired && tags.conditional_required !== true) continue

      const values = Array.isArray(obj.values)
        ? (obj.values as Array<Record<string, unknown>>).map(v => ({
            id:   String(v.id ?? ''),
            name: String(v.name ?? ''),
          })).filter(v => v.id && v.name)
        : undefined

      out.push({
        id,
        name,
        value_type:        obj.value_type as string | undefined,
        value_max_length:  typeof obj.value_max_length === 'number' ? obj.value_max_length : undefined,
        values:            values && values.length > 0 ? values : undefined,
        required:          isRequired,
        catalog_required:  isCatalogRequired,
        allows_variations: allowsVariations,
        hint:              obj.hint as string | undefined,
      })
    }
    // required primeiro, depois catalog_required
    out.sort((a, b) => {
      if (a.required !== b.required) return a.required ? -1 : 1
      if (a.catalog_required !== b.catalog_required) return a.catalog_required ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return out.slice(0, 50)
  }
}
