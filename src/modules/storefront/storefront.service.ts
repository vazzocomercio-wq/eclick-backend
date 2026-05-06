import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { LlmService } from '../ai/llm.service'
import { supabaseAdmin } from '../../common/supabase'

/** Onda 4 / A2 — Storefront personalization (rules + collections). */

export type RuleConditionType =
  | 'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_content'
  | 'referrer' | 'device' | 'time_range' | 'geo_state'
  | 'visited_product_category' | 'returning_visitor'

export interface RuleCondition {
  type:     RuleConditionType
  operator: 'eq' | 'neq' | 'contains' | 'between' | 'in'
  value:    unknown
}

export type RuleActionType =
  | 'highlight_products' | 'highlight_category' | 'show_banner'
  | 'show_coupon' | 'reorder_sections' | 'change_cta'
  | 'show_collection' | 'suggest_kit'

export interface RuleAction {
  type: RuleActionType
  // Campos variam
  product_ids?:    string[]
  category?:       string
  banner_data?:    Record<string, unknown>
  code?:           string
  discount_pct?:   number
  order?:          string[]
  text?:           string
  url?:            string
  collection_id?:  string
  kit_id?:         string
}

export interface StorefrontRule {
  id:               string
  organization_id:  string
  name:             string
  description:      string | null
  priority:         number
  conditions:       RuleCondition[]
  actions:          RuleAction[]
  enabled:          boolean
  impressions:      number
  conversions:      number
  conversion_rate:  number
  created_at:       string
  updated_at:       string
}

export type CollectionType = 'manual' | 'ai_generated' | 'rule_based' | 'seasonal'
export type CollectionStatus = 'draft' | 'active' | 'scheduled' | 'expired' | 'archived'

export interface ProductCollection {
  id:                   string
  organization_id:      string
  name:                 string
  slug:                 string
  description:          string | null
  cover_image_url:      string | null
  collection_type:      CollectionType
  product_ids:          string[]
  filter_rules:         Record<string, unknown>
  sort_order:           string
  max_products:         number
  status:               CollectionStatus
  active_from:          string | null
  active_until:         string | null
  landing_page_enabled: boolean
  landing_page_data:    Record<string, unknown>
  created_at:           string
  updated_at:           string
}

const COLLECTIONS_PROMPT = `Você é um curador de catálogo de e-commerce. Dado um catálogo
de produtos, sugira coleções comerciais por tema/categoria/ocasião.

REGRAS:
- 4-8 coleções
- Cada coleção tem 5-15 produtos
- Naming comercial atrativo
- product_ids reais do catálogo (não invente)
- Mix de tipos: por_ambiente, por_ocasiao, ai_generated
- Saída JSON puro`

@Injectable()
export class StorefrontService {
  private readonly logger = new Logger(StorefrontService.name)

  constructor(private readonly llm: LlmService) {}

  // ─────────────────────────────────────────────────────────────────
  // RULES
  // ─────────────────────────────────────────────────────────────────

  async listRules(orgId: string): Promise<StorefrontRule[]> {
    const { data, error } = await supabaseAdmin
      .from('storefront_rules')
      .select('*')
      .eq('organization_id', orgId)
      .order('priority', { ascending: true })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []) as StorefrontRule[]
  }

  async createRule(orgId: string, body: Partial<StorefrontRule>): Promise<StorefrontRule> {
    if (!body.name?.trim())  throw new BadRequestException('name obrigatório')
    if (!body.conditions || !Array.isArray(body.conditions)) throw new BadRequestException('conditions obrigatório (array)')
    if (!body.actions || !Array.isArray(body.actions))       throw new BadRequestException('actions obrigatório (array)')

    const { data, error } = await supabaseAdmin
      .from('storefront_rules')
      .insert({
        organization_id: orgId,
        name:            body.name,
        description:     body.description ?? null,
        priority:        body.priority ?? 0,
        conditions:      body.conditions,
        actions:         body.actions,
        enabled:         body.enabled ?? true,
      })
      .select('*')
      .maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)
    return data as StorefrontRule
  }

  async updateRule(id: string, orgId: string, patch: Partial<StorefrontRule>): Promise<StorefrontRule> {
    const allowed: (keyof StorefrontRule)[] = ['name','description','priority','conditions','actions','enabled']
    const safe: Record<string, unknown> = {}
    for (const k of allowed) if (k in patch) safe[k] = patch[k]
    if (Object.keys(safe).length === 0) throw new BadRequestException('nada pra atualizar')

    const { data, error } = await supabaseAdmin
      .from('storefront_rules').update(safe)
      .eq('id', id).eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)
    return data as StorefrontRule
  }

  async deleteRule(id: string, orgId: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('storefront_rules').delete()
      .eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  /** Resolve qual layout o visitante deve ver baseado em context.
   *  Avalia regras enabled em ordem de priority, retorna actions
   *  acumuladas da PRIMEIRA regra que matcheia (não merge). */
  async personalize(orgId: string, ctx: {
    utm_source?:    string
    utm_medium?:    string
    utm_campaign?:  string
    utm_content?:   string
    referrer?:      string
    device?:        'mobile' | 'desktop'
    geo_state?:     string
    visited_category?: string
    returning?:     boolean
    hour?:          number   // 0-23
  }): Promise<{
    matched_rule: StorefrontRule | null
    actions:      RuleAction[]
  }> {
    const rules = await this.listRules(orgId)
    const enabled = rules.filter(r => r.enabled).sort((a, b) => a.priority - b.priority)

    for (const rule of enabled) {
      if (this.evaluateConditions(rule.conditions, ctx)) {
        // Bump impressions (best-effort)
        await supabaseAdmin
          .from('storefront_rules')
          .update({ impressions: rule.impressions + 1 })
          .eq('id', rule.id)
        return { matched_rule: rule, actions: rule.actions }
      }
    }

    return { matched_rule: null, actions: [] }
  }

  private evaluateConditions(conditions: RuleCondition[], ctx: Record<string, unknown>): boolean {
    if (!conditions?.length) return true  // sem conditions = sempre matcheia

    for (const c of conditions) {
      const ctxVal = (ctx as Record<string, unknown>)[c.type === 'visited_product_category' ? 'visited_category'
                                                  : c.type === 'returning_visitor' ? 'returning'
                                                  : c.type]
      switch (c.operator) {
        case 'eq':       if (ctxVal !== c.value) return false; break
        case 'neq':      if (ctxVal === c.value) return false; break
        case 'contains':
          if (typeof ctxVal !== 'string' || !ctxVal.includes(String(c.value))) return false
          break
        case 'in':
          if (!Array.isArray(c.value) || !c.value.includes(ctxVal)) return false
          break
        case 'between': {
          const arr = Array.isArray(c.value) ? c.value as Array<string | number> : []
          if (arr.length !== 2) return false
          if (typeof ctxVal === 'number') {
            if (ctxVal < (arr[0] as number) || ctxVal > (arr[1] as number)) return false
          } else if (typeof ctxVal === 'string') {
            if (ctxVal < (arr[0] as string) || ctxVal > (arr[1] as string)) return false
          } else return false
          break
        }
      }
    }
    return true
  }

  // ─────────────────────────────────────────────────────────────────
  // COLLECTIONS
  // ─────────────────────────────────────────────────────────────────

  async listCollections(orgId: string): Promise<ProductCollection[]> {
    const { data, error } = await supabaseAdmin
      .from('product_collections')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []) as ProductCollection[]
  }

  async getCollection(id: string, orgId: string): Promise<ProductCollection> {
    const { data, error } = await supabaseAdmin
      .from('product_collections').select('*')
      .eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Coleção não encontrada')
    return data as ProductCollection
  }

  async createCollection(orgId: string, body: Partial<ProductCollection>): Promise<ProductCollection> {
    if (!body.name?.trim()) throw new BadRequestException('name obrigatório')
    const slug = body.slug ?? body.name.toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').slice(0, 80)

    const { data, error } = await supabaseAdmin
      .from('product_collections')
      .insert({
        organization_id:    orgId,
        name:               body.name,
        slug,
        description:        body.description ?? null,
        cover_image_url:    body.cover_image_url ?? null,
        collection_type:    body.collection_type ?? 'manual',
        product_ids:        body.product_ids ?? [],
        filter_rules:       body.filter_rules ?? {},
        sort_order:         body.sort_order ?? 'ai_score_desc',
        max_products:       body.max_products ?? 20,
        status:             body.status ?? 'draft',
        active_from:        body.active_from ?? null,
        active_until:       body.active_until ?? null,
        landing_page_enabled: body.landing_page_enabled ?? false,
        landing_page_data:    body.landing_page_data ?? {},
      })
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)
    return data as ProductCollection
  }

  async updateCollection(id: string, orgId: string, patch: Partial<ProductCollection>): Promise<ProductCollection> {
    const allowed: (keyof ProductCollection)[] = [
      'name','description','cover_image_url','collection_type','product_ids',
      'filter_rules','sort_order','max_products','status',
      'active_from','active_until','landing_page_enabled','landing_page_data',
    ]
    const safe: Record<string, unknown> = {}
    for (const k of allowed) if (k in patch) safe[k] = patch[k]
    if (Object.keys(safe).length === 0) throw new BadRequestException('nada pra atualizar')

    const { data, error } = await supabaseAdmin
      .from('product_collections').update(safe)
      .eq('id', id).eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)
    return data as ProductCollection
  }

  async deleteCollection(id: string, orgId: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('product_collections').delete()
      .eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  /** IA sugere coleções a partir do catálogo. */
  async generateCollections(orgId: string, count = 5): Promise<{ collections: ProductCollection[]; cost_usd: number }> {
    const { data: products, error } = await supabaseAdmin
      .from('products')
      .select('id, name, category, price, ai_score')
      .eq('organization_id', orgId)
      .neq('status', 'archived')
      .gte('ai_score', 50)
      .limit(80)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!products?.length) throw new BadRequestException('Sem produtos elegíveis')

    const userPrompt = `## CATÁLOGO (${products.length} produtos)
${products.map(p => `- ${(p as { id: string }).id} | ${(p as { name: string }).name} | R$${(p as { price: number }).price} | ${(p as { category: string | null }).category ?? '-'} | score ${(p as { ai_score: number | null }).ai_score}`).join('\n')}

## QUANTIDADE
${count} coleções

## SAÍDA — JSON
{
  "collections": [
    {
      "name": "string comercial",
      "description": "1 frase",
      "collection_type": "ai_generated"|"seasonal",
      "product_ids": [array de uuids reais do catalogo],
      "sort_order": "ai_score_desc"|"price_asc"|"price_desc"|"newest"|"best_selling"
    }
  ]
}`

    const out = await this.llm.generateText({
      orgId,
      feature:     'collections_generate',
      systemPrompt: COLLECTIONS_PROMPT,
      userPrompt,
      maxTokens:    2500,
      temperature:  0.5,
      jsonMode:     true,
    })

    let parsed: { collections?: Array<{ name: string; description?: string; collection_type?: CollectionType; product_ids?: string[]; sort_order?: string }> }
    try { parsed = JSON.parse(out.text) } catch { throw new BadRequestException('IA retornou JSON inválido') }
    if (!parsed.collections?.length) throw new BadRequestException('IA não retornou coleções')

    const validIds = new Set(products.map(p => (p as { id: string }).id))
    const created: ProductCollection[] = []
    for (const c of parsed.collections) {
      const filteredIds = (c.product_ids ?? []).filter(id => validIds.has(id))
      if (filteredIds.length < 3) continue
      try {
        const collection = await this.createCollection(orgId, {
          name:            c.name,
          description:     c.description ?? null,
          collection_type: c.collection_type ?? 'ai_generated',
          product_ids:     filteredIds,
          sort_order:      (c.sort_order ?? 'ai_score_desc'),
          status:          'draft',
        })
        created.push(collection)
      } catch (e) {
        this.logger.warn(`[collections] skip ${c.name}: ${(e as Error).message}`)
      }
    }
    return { collections: created, cost_usd: out.costUsd }
  }

  /** API pública pra carregar produtos de uma coleção. */
  async listCollectionProducts(orgId: string, slug: string): Promise<{ collection: ProductCollection; products: Array<Record<string, unknown>> }> {
    const { data: c, error } = await supabaseAdmin
      .from('product_collections').select('*')
      .eq('organization_id', orgId).eq('slug', slug).maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!c) throw new NotFoundException('Coleção não encontrada')

    const collection = c as ProductCollection
    if (collection.product_ids.length === 0) return { collection, products: [] }

    const { data: products } = await supabaseAdmin
      .from('products')
      .select('id, name, price, photo_urls, category, ai_score')
      .in('id', collection.product_ids)
      .neq('status', 'archived')
      .limit(collection.max_products)

    return { collection, products: (products ?? []) as Array<Record<string, unknown>> }
  }
}
