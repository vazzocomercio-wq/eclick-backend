/** ml_labels — cache de traducoes PT-BR (domain + attribute) vindas do ML.
 *
 *  Fluxo:
 *    1. Frontend pede /ml-quality/labels
 *    2. Service descobre dominios distintos nos snapshots da org
 *    3. Lookup em ml_labels (kind='domain', expires_at > now)
 *    4. Pra missing: fetch /domains/:id em paralelo (pool de 5), upsert
 *    5. Pra atributos: agrega missing_attributes nos snapshots, lookup
 *       em ml_labels (kind='attribute'), pra missing usa
 *       ml_category_attributes (jsonb com .name PT-BR ja vinda do ML)
 *       e tambem upsert no ml_labels pra cache rapido nas proximas
 *       chamadas
 *    6. Retorna { domains: { ID: name }, attributes: { ID: name } }
 *
 *  TTL: 30d (esses nomes nunca mudam na pratica).
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
      .select('ml_domain_id, pi_missing_attributes, ft_missing_attributes, all_missing_attributes, penalty_reasons')
      .eq('organization_id', orgId)
    if (sellerId != null) q = q.eq('seller_id', sellerId)

    const { data: rows } = await q
    if (!rows || rows.length === 0) {
      return { domains: {}, attributes: {} }
    }

    const domainIds = new Set<string>()
    const attrIds   = new Set<string>()
    for (const r of (rows as Array<{
      ml_domain_id: string | null
      pi_missing_attributes: string[] | null
      ft_missing_attributes: string[] | null
      all_missing_attributes: string[] | null
      penalty_reasons: string[] | null
    }>)) {
      if (r.ml_domain_id) domainIds.add(r.ml_domain_id)
      for (const a of r.pi_missing_attributes  ?? []) attrIds.add(a)
      for (const a of r.ft_missing_attributes  ?? []) attrIds.add(a)
      for (const a of r.all_missing_attributes ?? []) attrIds.add(a)
      // penalty_reasons sao keys tipo "incomplete_technical_specs" tambem
      // mas nao sao atributos — deixa raw na UI por enquanto
    }

    // 2. Carrega cache existente (nao expirado)
    const allIds = [...domainIds, ...attrIds]
    if (allIds.length === 0) {
      return { domains: {}, attributes: {} }
    }

    const { data: cached } = await supabaseAdmin
      .from('ml_labels')
      .select('kind, ml_id, name_pt, expires_at')
      .or(
        [
          domainIds.size > 0 ? `and(kind.eq.domain,ml_id.in.(${[...domainIds].map(quoteIn).join(',')}))`           : '',
          attrIds.size   > 0 ? `and(kind.eq.attribute,ml_id.in.(${[...attrIds].map(quoteIn).join(',')}))`         : '',
        ].filter(Boolean).join(','),
      )
      .gt('expires_at', new Date().toISOString())

    const cachedMap = new Map<string, string>()
    for (const c of (cached ?? []) as MlLabelRow[]) {
      cachedMap.set(`${c.kind}:${c.ml_id}`, c.name_pt)
    }

    // 3. Identifica o que falta
    const missingDomains = [...domainIds].filter(id => !cachedMap.has(`domain:${id}`))
    const missingAttrs   = [...attrIds].filter(id   => !cachedMap.has(`attribute:${id}`))

    // 4. Resolve missing via API ML (precisa de token)
    if (missingDomains.length > 0 || missingAttrs.length > 0) {
      try {
        const tokenRes = sellerId != null
          ? await this.ml.getTokenForOrg(orgId, sellerId).catch(() => null)
          : await this.ml.getTokenForOrg(orgId).catch(() => null)

        if (tokenRes) {
          const token = tokenRes.token

          // 4a. Domains — fetch em paralelo (pool de 5)
          await this.fetchAndCacheDomains(token, missingDomains, cachedMap)

          // 4b. Attributes — preferimos extrair de ml_category_attributes
          // (cache ja existente) antes de cair pra fetch direto
          await this.resolveAttributesFromCategoryCache(missingAttrs, cachedMap)
        }
      } catch (e) {
        this.logger.warn(`[ml-labels] resolve missing falhou: ${(e as Error).message}`)
      }
    }

    // 5. Monta dictionary
    const domains:    Record<string, string> = {}
    const attributes: Record<string, string> = {}
    for (const id of domainIds) {
      const name = cachedMap.get(`domain:${id}`)
      if (name) domains[id] = name
      else      domains[id] = humanize(id) // fallback
    }
    for (const id of attrIds) {
      const name = cachedMap.get(`attribute:${id}`)
      if (name) attributes[id] = name
      else      attributes[id] = humanize(id)
    }

    return { domains, attributes }
  }

  /** Fetch domains em paralelo (pool de 5) + upsert no cache. */
  private async fetchAndCacheDomains(token: string, ids: string[], cachedMap: Map<string, string>): Promise<void> {
    if (ids.length === 0) return
    const POOL = 5
    for (let i = 0; i < ids.length; i += POOL) {
      const batch = ids.slice(i, i + POOL)
      const results = await Promise.allSettled(
        batch.map(id => this.client.getDomain(token, id)),
      )
      const upserts: Array<{ kind: string; ml_id: string; name_pt: string; raw: unknown }> = []
      for (let j = 0; j < batch.length; j++) {
        const id = batch[j]!
        const res = results[j]!
        if (res.status === 'fulfilled' && res.value?.name) {
          cachedMap.set(`domain:${id}`, res.value.name)
          upserts.push({ kind: 'domain', ml_id: id, name_pt: res.value.name, raw: res.value })
        }
      }
      if (upserts.length > 0) {
        const { error } = await supabaseAdmin
          .from('ml_labels')
          .upsert(upserts, { onConflict: 'kind,ml_id' })
        if (error) this.logger.warn(`[ml-labels] upsert domains falhou: ${error.message}`)
      }
    }
  }

  /** Pra atributos, tenta resolver primeiro do cache de ml_category_attributes
   *  (que ja tem nome PT-BR vindo do ML quando catprod foi sincado). */
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
    }
  }
}

/** Escape pra IN clause Postgrest. Suporta strings com underscore/hifen. */
function quoteIn(s: string): string {
  // Postgrest IN syntax: in.(val1,val2). Strings com virgula/parenteses precisam quotar.
  return /[,()'"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

/** Fallback: gera nome legivel a partir do ID quando nao temos PT-BR. */
function humanize(id: string): string {
  return id
    .replace(/^MLB-/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
}
