/** ml_labels — cache de traducoes PT-BR vindas do ML.
 *
 *  ML nao expoe /domains/:id direto. A estrategia eh:
 *    1. Pra cada dominio distinto nos snapshots, pega 1 ml_item_id sample
 *    2. Authenticated GET /items?ids=...&attributes=id,category_id pra
 *       mapear item -> category_id
 *    3. Public GET /categories/:cat_id (sem auth) -> name PT-BR
 *    4. Cache em ml_labels com TTL 30d
 *
 *  Pra atributos: usa cache existente de ml_category_attributes onde
 *  cada attr ja tem .name PT-BR vindo do ML.
 */

import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import { MlQualityApiClient } from './ml-quality-api.client'

interface MlLabelRow {
  kind:       'domain' | 'attribute'
  ml_id:      string
  name_pt:    string
  expires_at: string
}

@Injectable()
export class MlLabelsService {
  private readonly logger = new Logger(MlLabelsService.name)

  constructor(
    private readonly ml:     MercadolivreService,
    private readonly client: MlQualityApiClient,
  ) {}

  /** Endpoint principal — devolve dictionary completo pro frontend. */
  async getLabelsForOrg(orgId: string, sellerId?: number): Promise<{
    domains:    Record<string, string>
    attributes: Record<string, string>
  }> {
    // 1. Pega dominios + atributos faltantes distintos dos snapshots
    let q = supabaseAdmin
      .from('ml_quality_snapshots')
      .select('ml_domain_id, ml_item_id, pi_missing_attributes, ft_missing_attributes, all_missing_attributes')
      .eq('organization_id', orgId)
    if (sellerId != null) q = q.eq('seller_id', sellerId)

    const { data: rows } = await q
    if (!rows || rows.length === 0) {
      return { domains: {}, attributes: {} }
    }

    const typedRows = rows as Array<{
      ml_domain_id: string | null
      ml_item_id:   string
      pi_missing_attributes: string[] | null
      ft_missing_attributes: string[] | null
      all_missing_attributes: string[] | null
    }>

    const domainIds = new Set<string>()
    const attrIds   = new Set<string>()
    const domainSampleItem = new Map<string, string>() // domain_id -> primeiro ml_item_id encontrado

    for (const r of typedRows) {
      if (r.ml_domain_id) {
        domainIds.add(r.ml_domain_id)
        if (!domainSampleItem.has(r.ml_domain_id)) {
          domainSampleItem.set(r.ml_domain_id, r.ml_item_id)
        }
      }
      for (const a of r.pi_missing_attributes  ?? []) attrIds.add(a)
      for (const a of r.ft_missing_attributes  ?? []) attrIds.add(a)
      for (const a of r.all_missing_attributes ?? []) attrIds.add(a)
    }

    if (domainIds.size === 0 && attrIds.size === 0) {
      return { domains: {}, attributes: {} }
    }

    // 2. Carrega cache existente (nao expirado)
    const orFilters: string[] = []
    if (domainIds.size > 0) orFilters.push(`and(kind.eq.domain,ml_id.in.(${[...domainIds].map(quoteIn).join(',')}))`)
    if (attrIds.size   > 0) orFilters.push(`and(kind.eq.attribute,ml_id.in.(${[...attrIds].map(quoteIn).join(',')}))`)

    const cachedMap = new Map<string, string>()
    if (orFilters.length > 0) {
      const { data: cached } = await supabaseAdmin
        .from('ml_labels')
        .select('kind, ml_id, name_pt, expires_at')
        .or(orFilters.join(','))
        .gt('expires_at', new Date().toISOString())

      for (const c of (cached ?? []) as MlLabelRow[]) {
        cachedMap.set(`${c.kind}:${c.ml_id}`, c.name_pt)
      }
    }

    // 3. Identifica missing
    const missingDomains = [...domainIds].filter(id => !cachedMap.has(`domain:${id}`))
    const missingAttrs   = [...attrIds].filter(id   => !cachedMap.has(`attribute:${id}`))

    // 4. Resolve missing
    if (missingDomains.length > 0 || missingAttrs.length > 0) {
      try {
        const tokenRes = sellerId != null
          ? await this.ml.getTokenForOrg(orgId, sellerId).catch(() => null)
          : await this.ml.getTokenForOrg(orgId).catch(() => null)

        if (tokenRes) {
          const token = tokenRes.token

          // 4a. Domains via items → category, e ja extrai attribute names
          //     da mesma categoria pra resolver atributos missing tambem
          if (missingDomains.length > 0) {
            await this.fetchAndCacheDomains(token, missingDomains, domainSampleItem, cachedMap, missingAttrs)
          }

          // 4b. Atributos ainda missing depois de 4a: tenta cache
          //     existente em ml_category_attributes
          const stillMissingAttrs = missingAttrs.filter(id => !cachedMap.has(`attribute:${id}`))
          if (stillMissingAttrs.length > 0) {
            await this.resolveAttributesFromCategoryCache(stillMissingAttrs, cachedMap)
          }
        } else {
          this.logger.warn(`[ml-labels] sem token disponivel pra org=${orgId} (skip resolve)`)
        }
      } catch (e) {
        this.logger.warn(`[ml-labels] resolve missing falhou: ${(e as Error).message}`)
      }
    }

    // 5. Monta dictionary final (com fallback humanize pra ids ainda missing)
    const domains:    Record<string, string> = {}
    const attributes: Record<string, string> = {}
    for (const id of domainIds) {
      domains[id] = cachedMap.get(`domain:${id}`) ?? humanize(id)
    }
    for (const id of attrIds) {
      attributes[id] = cachedMap.get(`attribute:${id}`) ?? humanize(id)
    }

    return { domains, attributes }
  }

  /** Resolve domain → name via items → category, e tambem extrai attribute
   *  names das mesmas categorias (sem auth). Pool de 5 em paralelo. */
  private async fetchAndCacheDomains(
    token:        string,
    domainIds:    string[],
    sampleItems:  Map<string, string>,
    cachedMap:    Map<string, string>,
    missingAttrs: string[],
  ): Promise<void> {
    // 1. Coleta sample items pra dominios missing
    const itemToDomain = new Map<string, string>()
    for (const dId of domainIds) {
      const sample = sampleItems.get(dId)
      if (sample) itemToDomain.set(sample, dId)
    }
    const itemIds = [...itemToDomain.keys()]
    if (itemIds.length === 0) return

    // 2. Batch fetch items em chunks de 20
    const itemToCategory = new Map<string, string>()
    for (let i = 0; i < itemIds.length; i += 20) {
      const batch = itemIds.slice(i, i + 20)
      try {
        const items = await this.client.getItemsBatch(token, batch)
        for (const it of items) {
          if (it.id && it.category_id) itemToCategory.set(it.id, it.category_id)
        }
      } catch (e) {
        this.logger.warn(`[ml-labels] getItemsBatch falhou: ${(e as Error).message}`)
      }
    }

    // 3. domain → category
    const domainToCategory = new Map<string, string>()
    for (const [item, domain] of itemToDomain) {
      const cat = itemToCategory.get(item)
      if (cat) domainToCategory.set(domain, cat)
    }

    // 4. Para cada categoria unica, fetch /categories/:id E
    //    /categories/:id/attributes em paralelo (pool 5)
    const categoryIds = [...new Set(domainToCategory.values())]
    const categoryToName = new Map<string, string>()
    const attrIdToName   = new Map<string, string>()
    const POOL = 5
    for (let i = 0; i < categoryIds.length; i += POOL) {
      const batch = categoryIds.slice(i, i + POOL)
      const results = await Promise.allSettled(
        batch.flatMap(cId => [
          this.client.getCategoryName(cId).then(r => ({ kind: 'name' as const, cId, data: r })),
          this.client.getCategoryAttributesPublic(cId).then(r => ({ kind: 'attrs' as const, cId, data: r })),
        ]),
      )
      for (const r of results) {
        if (r.status !== 'fulfilled') continue
        if (r.value.kind === 'name' && r.value.data?.name) {
          categoryToName.set(r.value.cId, r.value.data.name)
        }
        if (r.value.kind === 'attrs' && Array.isArray(r.value.data)) {
          for (const a of r.value.data) {
            if (a.id && a.name && !attrIdToName.has(a.id)) attrIdToName.set(a.id, a.name)
          }
        }
      }
    }

    // 5. Upsert ml_labels (domains + attributes encontrados)
    const upserts: Array<{ kind: string; ml_id: string; name_pt: string; raw: unknown }> = []
    for (const [domain, cat] of domainToCategory) {
      const name = categoryToName.get(cat)
      if (name) {
        cachedMap.set(`domain:${domain}`, name)
        upserts.push({
          kind:    'domain',
          ml_id:   domain,
          name_pt: name,
          raw:     { resolved_via: 'category', category_id: cat },
        })
      }
    }
    // Atributos: so cacheia os que estao em missingAttrs (evita poluir
    // cache com 100s de attrs irrelevantes pra org)
    const missingAttrSet = new Set(missingAttrs)
    for (const [attrId, name] of attrIdToName) {
      if (!missingAttrSet.has(attrId)) continue
      cachedMap.set(`attribute:${attrId}`, name)
      upserts.push({
        kind:    'attribute',
        ml_id:   attrId,
        name_pt: name,
        raw:     { resolved_via: 'category_attributes' },
      })
    }
    if (upserts.length > 0) {
      const { error } = await supabaseAdmin
        .from('ml_labels')
        .upsert(upserts, { onConflict: 'kind,ml_id' })
      if (error) this.logger.warn(`[ml-labels] upsert falhou: ${error.message}`)
      else      this.logger.log(`[ml-labels] cached ${upserts.length} labels (${categoryToName.size} domains, ${attrIdToName.size} attrs)`)
    }
  }

  /** Pra atributos, resolve do cache de ml_category_attributes (que ja tem
   *  nome PT-BR vindo do ML quando outras categorias foram sincadas). */
  private async resolveAttributesFromCategoryCache(ids: string[], cachedMap: Map<string, string>): Promise<void> {
    if (ids.length === 0) return

    const { data: catAttrs } = await supabaseAdmin
      .from('ml_category_attributes')
      .select('attributes')

    if (!catAttrs || catAttrs.length === 0) return

    const seen = new Set<string>()
    const upserts: Array<{ kind: string; ml_id: string; name_pt: string; raw: unknown }> = []

    for (const row of (catAttrs as Array<{ attributes: Array<{ id: string; name: string }> }>)) {
      const arr = Array.isArray(row.attributes) ? row.attributes : []
      for (const a of arr) {
        if (!a?.id || !a?.name) continue
        if (!ids.includes(a.id))  continue
        if (seen.has(a.id))       continue
        seen.add(a.id)
        cachedMap.set(`attribute:${a.id}`, a.name)
        upserts.push({ kind: 'attribute', ml_id: a.id, name_pt: a.name, raw: { id: a.id, name: a.name } })
      }
    }

    if (upserts.length > 0) {
      const { error } = await supabaseAdmin
        .from('ml_labels')
        .upsert(upserts, { onConflict: 'kind,ml_id' })
      if (error) this.logger.warn(`[ml-labels] upsert attributes falhou: ${error.message}`)
      else      this.logger.log(`[ml-labels] cached ${upserts.length} attribute labels`)
    }
  }
}

function quoteIn(s: string): string {
  return /[,()'"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

function humanize(id: string): string {
  return id
    .replace(/^MLB-/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
}
