import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { MercadolivreService } from '../../mercadolivre/mercadolivre.service'

const ML_BASE = 'https://api.mercadolibre.com'

/**
 * Detecta anúncios pausados (status=paused) ou inativos (status=closed)
 * e cria tasks `INACTIVE_PAUSED`. v1 (Sprint 2) usa classificação genérica
 * via sub_status / tags. L3 vai refinar pra categorias específicas
 * (out_of_stock / moderation_pending / policy_violation / image_problem...).
 *
 * Fluxo:
 *  1. Lista items paused + closed via /users/{seller}/items/search
 *  2. Pra cada, GET /items/{id} pra inspecionar sub_status, tags, warnings
 *  3. Classifica motivo (genérico) e severity
 *  4. Upsert task active de tipo INACTIVE_PAUSED
 *  5. Auto-resolve quando item volta pra active (>6h sem aparecer)
 */
@Injectable()
export class ListingStatusScannerService {
  private readonly logger = new Logger(ListingStatusScannerService.name)

  constructor(private readonly ml: MercadolivreService) {}

  async scan(orgId: string, sellerId: number): Promise<{
    items_scanned: number
    inactive_found: number
    tasks_created: number
    tasks_updated: number
    tasks_resolved_auto: number
    api_calls: number
  }> {
    const t0 = Date.now()
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)

    // 1. Items pausados + fechados
    const pausedIds = await this.fetchItemIdsByStatus(token, sellerId, 'paused')
    const closedIds = await this.fetchItemIdsByStatus(token, sellerId, 'closed')
    const allIds = [...pausedIds, ...closedIds]
    let apiCalls = 2 + Math.ceil(allIds.length / 50)

    let created = 0
    let updated = 0

    for (const itemId of allIds) {
      try {
        const { data: item } = await axios.get(`${ML_BASE}/items/${itemId}`, {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            attributes: 'id,status,sub_status,tags,warnings,available_quantity,sold_quantity,price,title,last_updated,date_created',
          },
          timeout: 8000,
        })
        apiCalls++

        const reason = this.classifyReason(item)
        const result = await this.upsertInactiveTask(orgId, sellerId, item, reason)
        if (result === 'created') created++
        else if (result === 'updated') updated++

        // Sprint 6 — popula pause_classifications com categoria específica
        await this.upsertPauseClassification(orgId, sellerId, item)
      } catch (err) {
        this.logger.warn(`[status-scanner] /items/${itemId}: ${(err as Error).message}`)
      }
      await new Promise(res => setTimeout(res, 100))
    }

    const resolvedAuto = await this.autoResolveReactivated(orgId, sellerId)

    this.logger.log(
      `[status-scanner] org=${orgId.slice(0, 8)} seller=${sellerId} ` +
      `paused=${pausedIds.length} closed=${closedIds.length} ` +
      `created=${created} updated=${updated} resolved=${resolvedAuto} ` +
      `em ${Math.round((Date.now() - t0) / 1000)}s`,
    )

    return {
      items_scanned: allIds.length,
      inactive_found: allIds.length,
      tasks_created: created,
      tasks_updated: updated,
      tasks_resolved_auto: resolvedAuto,
      api_calls: apiCalls,
    }
  }

  private async fetchItemIdsByStatus(token: string, sellerId: number, status: 'paused' | 'closed'): Promise<string[]> {
    const ids: string[] = []
    let offset = 0
    const limit = 50
    const SAFETY_CAP = 5000

    while (offset < SAFETY_CAP) {
      try {
        const { data } = await axios.get(`${ML_BASE}/users/${sellerId}/items/search`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { status, limit, offset },
          timeout: 10_000,
        })
        const page = (data.results ?? []) as string[]
        if (page.length === 0) break
        ids.push(...page)
        if (page.length < limit) break
        offset += limit
      } catch (err) {
        this.logger.warn(`[status-scanner] search ${status} offset=${offset}: ${(err as Error).message}`)
        break
      }
    }
    return ids
  }

  private async upsertInactiveTask(
    orgId: string,
    sellerId: number,
    item: {
      id: string
      status: string
      sub_status?: string[]
      tags?: string[]
      title?: string
      sold_quantity?: number
      price?: number
      last_updated?: string
      date_created?: string
    },
    reason: { description: string; severity: 'critical' | 'high' | 'medium' | 'low'; suggested_action: string },
  ): Promise<'created' | 'updated' | 'skipped'> {
    const priority = this.computePriority(item, reason.severity)

    const { data: existing } = await supabaseAdmin
      .from('ml_listing_tasks')
      .select('id, detection_count')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .eq('ml_item_id', item.id)
      .eq('task_type', 'INACTIVE_PAUSED')
      .in('status', ['open', 'snoozed', 'in_progress'])
      .maybeSingle()

    if (existing) {
      const e = existing as { id: string; detection_count: number | null }
      await supabaseAdmin
        .from('ml_listing_tasks')
        .update({
          last_seen_at: new Date().toISOString(),
          detection_count: (e.detection_count ?? 1) + 1,
          severity: reason.severity,
          priority_score: priority,
          updated_at: new Date().toISOString(),
        })
        .eq('id', e.id)
      return 'updated'
    }

    const { error } = await supabaseAdmin.from('ml_listing_tasks').insert({
      organization_id: orgId,
      seller_id: sellerId,
      ml_item_id: item.id,
      task_type: 'INACTIVE_PAUSED',
      task_title: item.status === 'paused'
        ? 'Anúncio pausado'
        : 'Anúncio inativo',
      task_description: item.title
        ? `${item.title.slice(0, 60)} · ${reason.description}`
        : reason.description,
      source: 'scanner_status',
      severity: reason.severity,
      priority_score: priority,
      impact_area: ['sales', 'compliance'],
      current_value: {
        status: item.status,
        sub_status: item.sub_status ?? [],
        tags: item.tags ?? [],
        sold_quantity: item.sold_quantity,
        price: item.price,
      },
      suggested_action: reason.suggested_action,
      estimated_impact_brl: this.estimateMonthlyImpact(item),
      deeplink_url: `https://eclick.app.br/dashboard/listings/items/${item.id}`,
      deeplink_module: 'listing_center',
      status: 'open',
    })

    if (error) {
      this.logger.warn(`[status-scanner] insert ${item.id}: ${error.message}`)
      return 'skipped'
    }
    return 'created'
  }

  private async autoResolveReactivated(orgId: string, sellerId: number): Promise<number> {
    const sixHoursAgo = new Date(Date.now() - 6 * 3600_000).toISOString()
    const { data, error } = await supabaseAdmin
      .from('ml_listing_tasks')
      .update({
        status: 'resolved_auto',
        resolved_at: new Date().toISOString(),
        resolution_notes: 'Anúncio reativado (não detectado como pausado/inativo)',
      })
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .eq('task_type', 'INACTIVE_PAUSED')
      .eq('source', 'scanner_status')
      .eq('status', 'open')
      .lt('last_seen_at', sixHoursAgo)
      .select('id')

    if (error) {
      this.logger.warn(`[status-scanner] auto-resolve: ${error.message}`)
      return 0
    }
    return data?.length ?? 0
  }

  /** L3 Sprint 6 — categorização fina por motivo de pausa. Espelha as
   *  categorias do CHECK em ml_listing_pause_classifications. */
  private classifyCategory(item: {
    status: string
    sub_status?: string[]
    tags?: string[]
  }): {
    category: 'out_of_stock' | 'paused_by_seller' | 'moderation_pending' |
              'policy_violation' | 'image_problem' | 'description_problem' |
              'price_problem' | 'category_problem' | 'restricted_product' |
              'incomplete_required_fields' | 'expired' | 'unknown'
    severity: 'critical' | 'high' | 'medium' | 'low'
    is_self_solvable: boolean
    suggested_fix: string
  } {
    const subs = (item.sub_status ?? []).map(s => String(s).toLowerCase())
    const tags = (item.tags ?? []).map(t => String(t).toLowerCase())
    const all = [...subs, ...tags]

    // Critical — violações de política / produtos restritos
    if (all.some(s => s.includes('policy') || s.includes('infraction'))) {
      return {
        category: 'policy_violation', severity: 'critical', is_self_solvable: false,
        suggested_fix: 'Anúncio viola política ML — abrir contestação ou remover',
      }
    }
    if (all.some(s => s.includes('restricted'))) {
      return {
        category: 'restricted_product', severity: 'critical', is_self_solvable: false,
        suggested_fix: 'Produto restrito pelo ML — verificar regras de categoria',
      }
    }

    // High — moderação pendente
    if (all.some(s => s.includes('moderation'))) {
      return {
        category: 'moderation_pending', severity: 'high', is_self_solvable: false,
        suggested_fix: 'Aguardar análise ML ou abrir contestação',
      }
    }

    // High — sem estoque (acionável)
    if (subs.includes('out_of_stock') || tags.includes('out_of_stock')) {
      return {
        category: 'out_of_stock', severity: 'high', is_self_solvable: true,
        suggested_fix: 'Repor estoque no Catálogo ou pausar definitivamente',
      }
    }

    // Medium — problemas de conteúdo
    if (all.some(s => s.includes('image') || s.includes('picture') || s.includes('photo'))) {
      return {
        category: 'image_problem', severity: 'medium', is_self_solvable: true,
        suggested_fix: 'Atualizar foto principal (mínimo 500px, fundo branco)',
      }
    }
    if (all.some(s => s.includes('description') || s.includes('desc'))) {
      return {
        category: 'description_problem', severity: 'medium', is_self_solvable: true,
        suggested_fix: 'Revisar descrição (sem links, contatos ou termos proibidos)',
      }
    }
    if (all.some(s => s.includes('price') && !s.includes('automation'))) {
      return {
        category: 'price_problem', severity: 'medium', is_self_solvable: true,
        suggested_fix: 'Revisar preço — valor inválido ou fora do range permitido',
      }
    }
    if (all.some(s => s.includes('category'))) {
      return {
        category: 'category_problem', severity: 'medium', is_self_solvable: true,
        suggested_fix: 'Mover anúncio pra categoria correta',
      }
    }
    if (all.some(s => s.includes('required') || s.includes('attribute') || s.includes('mandatory'))) {
      return {
        category: 'incomplete_required_fields', severity: 'medium', is_self_solvable: true,
        suggested_fix: 'Preencher atributos obrigatórios (ficha técnica)',
      }
    }

    // Low — pausas voluntárias / closed comum
    if (subs.includes('expired') || tags.includes('expired')) {
      return {
        category: 'expired', severity: 'low', is_self_solvable: true,
        suggested_fix: 'Anúncio expirou — relistar se quiser continuar vendendo',
      }
    }
    if (item.status === 'closed') {
      return {
        category: 'paused_by_seller', severity: 'low', is_self_solvable: true,
        suggested_fix: 'Reativar se ainda quer vender, ou descartar',
      }
    }
    if (item.status === 'paused' && subs.length === 0 && tags.length === 0) {
      return {
        category: 'paused_by_seller', severity: 'low', is_self_solvable: true,
        suggested_fix: 'Pausado manualmente — reativar quando desejado',
      }
    }

    return {
      category: 'unknown', severity: 'medium', is_self_solvable: false,
      suggested_fix: `Investigar motivo (sub_status: ${(item.sub_status ?? []).join(', ') || '-'})`,
    }
  }

  private async upsertPauseClassification(orgId: string, sellerId: number, item: {
    id: string
    status: string
    sub_status?: string[]
    tags?: string[]
    warnings?: unknown
    title?: string
    price?: number
    sold_quantity?: number
    date_created?: string
    last_updated?: string
  }): Promise<void> {
    const cls = this.classifyCategory(item)
    const pausedSince = item.last_updated ?? item.date_created ?? null
    const daysPaused = pausedSince
      ? Math.floor((Date.now() - new Date(pausedSince).getTime()) / 86400_000)
      : null

    const { error } = await supabaseAdmin.from('ml_listing_pause_classifications').upsert({
      organization_id:    orgId,
      seller_id:          sellerId,
      ml_item_id:         item.id,
      ml_status:          item.status,
      ml_sub_status:      item.sub_status ?? [],
      ml_tags:            item.tags ?? [],
      ml_warnings:        item.warnings ?? null,
      pause_category:     cls.category,
      pause_severity:     cls.severity,
      is_self_solvable:   cls.is_self_solvable,
      suggested_fix:      cls.suggested_fix,
      paused_since:       pausedSince,
      days_paused:        daysPaused,
      item_title:         item.title ?? null,
      item_price:         item.price ?? null,
      item_sold_quantity: item.sold_quantity ?? null,
      fetched_at:         new Date().toISOString(),
    }, { onConflict: 'organization_id,seller_id,ml_item_id' })

    if (error) {
      this.logger.warn(`[status-scanner] pause_class upsert ${item.id}: ${error.message}`)
    }
  }

  /** Classificação genérica v1 — refinada em L3 pra categorias específicas. */
  private classifyReason(item: {
    status: string
    sub_status?: string[]
    tags?: string[]
    sold_quantity?: number
  }): { description: string; severity: 'critical' | 'high' | 'medium' | 'low'; suggested_action: string } {
    const subs = item.sub_status ?? []
    const tags = item.tags ?? []

    if (subs.includes('out_of_stock')) {
      return {
        description: 'Pausado por falta de estoque',
        severity: 'high',
        suggested_action: 'Repor estoque e reativar anúncio',
      }
    }
    if (tags.includes('moderation_pending') || subs.includes('moderation_pending')) {
      return {
        description: 'Em moderação ML',
        severity: 'high',
        suggested_action: 'Aguardar análise ou contestar via ML',
      }
    }
    if (subs.some(s => s.includes('warning')) || tags.some(t => t.includes('warning'))) {
      return {
        description: 'Anúncio com aviso ML',
        severity: 'high',
        suggested_action: 'Revisar avisos no painel ML e corrigir',
      }
    }
    if (item.status === 'closed') {
      return {
        description: 'Anúncio inativo (closed)',
        severity: (item.sold_quantity ?? 0) > 10 ? 'medium' : 'low',
        suggested_action: 'Reativar se ainda quiser vender, ou descartar',
      }
    }
    return {
      description: subs.length > 0 ? `Pausado: ${subs.join(', ')}` : 'Pausado pelo vendedor',
      severity: (item.sold_quantity ?? 0) > 10 ? 'medium' : 'low',
      suggested_action: 'Investigar motivo e reativar se aplicável',
    }
  }

  private computePriority(item: { sold_quantity?: number }, severity: string): number {
    const sold = item.sold_quantity ?? 0
    const base = { critical: 90, high: 70, medium: 50, low: 30 }[severity] ?? 30
    if (sold > 100) return Math.min(100, base + 10)
    if (sold > 50) return Math.min(100, base + 5)
    return base
  }

  private estimateMonthlyImpact(item: { sold_quantity?: number; price?: number }): number | null {
    const sold = item.sold_quantity ?? 0
    const price = item.price ?? 0
    if (sold === 0 || price === 0) return null
    return Math.round((sold / 12) * price)
  }
}
