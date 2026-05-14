import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { MercadolivreService } from '../../mercadolivre/mercadolivre.service'

const ML_BASE = 'https://api.mercadolibre.com'

/**
 * F10 Passo 2 — Scanner SEO estrutural.
 *
 * Roda diário, calcula score 0-100 pra cada anúncio ativo SEM chamar LLM
 * (puramente regras: título, atributos, fotos). Persiste em
 * ml_listing_seo_scores + cria tasks SEO_LOW quando score < 60.
 *
 * Pesos:
 *   Title       40%  (length sweet-spot 50-60, tem brand, não excede 60)
 *   Attributes  40%  (% required + % recomendados preenchidos via quality snapshot)
 *   Pictures    20%  (≥6 ideal, ≥3 ok, <3 ruim)
 *
 * IMPORTANTE: É score ESTRUTURAL barato (sem keywords/research). O score
 * "rico" do e-otimizer (que faz pesquisa de categoria) pode divergir —
 * UI explica que esse é apenas o estrutural.
 *
 * Custo ML API: ~5000 items / 20 batch = 250 calls (~25s pacing 100ms).
 * Não chama /items/{id}/description (eviting per-item call) — descrição
 * fica como pendência v2.
 *
 * Tasks criadas:
 *   - SEO_LOW                      → score < 60
 *   - SEO_HIGH_VISITS_LOW_SCORE    → score < 70 E visits_period ≥ 100
 *
 * Visits vêm de ml_item_visits_period (F11 visits-scanner já popula).
 * Normalizamos pra escala 30d via (visits / period_days) * 30.
 */

interface MlBatchItem {
  code: number
  body?: {
    id?: string
    title?: string
    available_quantity?: number
    sold_quantity?: number
    price?: number
    pictures?: Array<{ id: string; url: string }>
    listing_type_id?: string
    catalog_listing?: boolean
    status?: string
    category_id?: string
  }
}

interface QualitySnapshotRow {
  ml_item_id:                string
  pi_missing_count:          number | null
  pi_filled_count:           number | null
  ft_missing_count:          number | null
  ft_filled_count:           number | null
  all_missing_count:         number | null
  all_filled_count:          number | null
  pi_missing_attributes:     string[] | null
  ft_missing_attributes:     string[] | null
  has_exposure_penalty:      boolean | null
}

interface VisitsRow {
  ml_item_id:    string
  period_days:   number
  total_visits:  number
  period_end:    string
}

interface Issue {
  code:     string
  area:     'title' | 'attributes' | 'pictures' | 'description' | 'general'
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  message:  string
}

@Injectable()
export class ListingSeoScannerService {
  private readonly logger = new Logger(ListingSeoScannerService.name)

  constructor(private readonly ml: MercadolivreService) {}

  async scan(orgId: string, sellerId: number): Promise<{
    items_scanned:        number
    scores_upserted:      number
    tasks_created:        number
    tasks_updated:        number
    tasks_resolved_auto:  number
    api_calls:            number
  }> {
    const t0 = Date.now()
    // Multi-conta — gotcha feedback_ml_multiconta_token
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)

    // 1. Pagina items ativos via /users/{seller}/items/search (mesmo do stock scanner)
    const allActiveIds = await this.fetchActiveItemIds(token, sellerId)
    if (allActiveIds.length === 0) {
      this.logger.log(`[seo-scanner] org=${orgId.slice(0, 8)} seller=${sellerId} sem items ativos — pulando`)
      return { items_scanned: 0, scores_upserted: 0, tasks_created: 0, tasks_updated: 0, tasks_resolved_auto: 0, api_calls: 0 }
    }

    let apiCalls = 1 + Math.ceil(allActiveIds.length / 50)

    // 2. Pre-load atributos do quality_snapshots e visits do period em 1 query cada
    const [qualityMap, visitsMap] = await Promise.all([
      this.loadQualitySnapshots(orgId, sellerId, allActiveIds),
      this.loadVisits(orgId, sellerId, allActiveIds),
    ])

    // 3. Batch fetch ML items (20 ids/call)
    let scoresUpserted = 0
    let tasksCreated = 0
    let tasksUpdated = 0
    const seenItems: Set<string> = new Set()

    const BATCH_SIZE = 20
    for (let i = 0; i < allActiveIds.length; i += BATCH_SIZE) {
      const slice = allActiveIds.slice(i, i + BATCH_SIZE)
      try {
        const { data } = await axios.get<MlBatchItem[]>(`${ML_BASE}/items`, {
          headers: { Authorization: `Bearer ${token}` },
          params:  {
            ids:        slice.join(','),
            attributes: 'id,title,available_quantity,sold_quantity,price,pictures,listing_type_id,catalog_listing,status',
          },
          timeout: 15_000,
        })
        apiCalls++

        for (const entry of data) {
          if (entry.code !== 200 || !entry.body?.id) continue
          const itemBody = entry.body
          const itemId = itemBody.id!
          seenItems.add(itemId)

          const score = this.computeStructuralScore(itemBody, qualityMap.get(itemId))
          const visits30d = this.normalizeVisitsTo30d(visitsMap.get(itemId))

          // Upsert score
          const upsertOk = await this.upsertScore(orgId, sellerId, itemId, itemBody, score, visits30d, qualityMap.get(itemId))
          if (upsertOk) scoresUpserted++

          // Cria/atualiza task se score baixo
          if (score.structural < 60) {
            const result = await this.upsertSeoLowTask(orgId, sellerId, itemId, itemBody, score, visits30d)
            if (result === 'created') tasksCreated++
            else if (result === 'updated') tasksUpdated++
          } else if (score.structural < 70 && visits30d >= 100) {
            const result = await this.upsertHighVisitsLowScoreTask(orgId, sellerId, itemId, itemBody, score, visits30d)
            if (result === 'created') tasksCreated++
            else if (result === 'updated') tasksUpdated++
          }
        }
      } catch (err) {
        this.logger.warn(`[seo-scanner] batch ids=${slice[0]}... falhou: ${(err as Error).message}`)
      }
      // pacing 100ms entre batches
      await new Promise(res => setTimeout(res, 100))
    }

    // 4. Auto-resolve tasks de items que melhoraram score (não estão mais < 60)
    const resolvedAuto = await this.autoResolveImproved(orgId, sellerId)

    this.logger.log(
      `[seo-scanner] org=${orgId.slice(0, 8)} seller=${sellerId} ` +
      `items=${allActiveIds.length} scores=${scoresUpserted} ` +
      `tasks_created=${tasksCreated} updated=${tasksUpdated} resolved=${resolvedAuto} ` +
      `api_calls=${apiCalls} em ${Math.round((Date.now() - t0) / 1000)}s`,
    )

    return {
      items_scanned:       allActiveIds.length,
      scores_upserted:     scoresUpserted,
      tasks_created:       tasksCreated,
      tasks_updated:       tasksUpdated,
      tasks_resolved_auto: resolvedAuto,
      api_calls:           apiCalls,
    }
  }

  // ── Score computation ────────────────────────────────────────────────────

  /** Score estrutural 0-100. */
  computeStructuralScore(
    item: MlBatchItem['body'],
    quality: QualitySnapshotRow | undefined,
  ): {
    title:       number
    description: number      // não scoreio em v1 → fica 50 (neutro)
    attributes:  number
    pictures:    number
    structural:  number
    issues:      Issue[]
  } {
    const issues: Issue[] = []
    if (!item) {
      return { title: 0, description: 0, attributes: 0, pictures: 0, structural: 0, issues }
    }

    // Title
    const title = item.title ?? ''
    const titleLen = title.length
    let titleScore = 50
    if (titleLen === 0) {
      titleScore = 0
      issues.push({ code: 'TITLE_EMPTY', area: 'title', severity: 'critical', message: 'Anúncio sem título' })
    } else if (titleLen < 30) {
      titleScore = 30
      issues.push({ code: 'TITLE_SHORT', area: 'title', severity: 'high', message: `Título curto (${titleLen}/60)` })
    } else if (titleLen > 60) {
      titleScore = 40
      issues.push({ code: 'TITLE_OVER', area: 'title', severity: 'medium', message: `Título excede limite (${titleLen}/60)` })
    } else if (titleLen >= 50) {
      titleScore = 95   // sweet spot
    } else if (titleLen >= 40) {
      titleScore = 80
    } else {
      titleScore = 65   // 30-39 chars
    }

    // Attributes — usa snapshot ML quality (mais confiável que /items.attributes)
    let attrScore = 50
    if (quality) {
      const piMissing = quality.pi_missing_count ?? 0
      const ftMissing = quality.ft_missing_count ?? 0
      const piFilled  = quality.pi_filled_count  ?? 0
      const ftFilled  = quality.ft_filled_count  ?? 0
      const totalSlots = piMissing + piFilled + ftMissing + ftFilled
      if (totalSlots > 0) {
        const filledPct = (piFilled + ftFilled) / totalSlots
        attrScore = Math.round(filledPct * 100)
      }
      if (piMissing > 0) {
        issues.push({
          code:     'PI_MISSING',
          area:     'attributes',
          severity: 'high',
          message:  `Faltam ${piMissing} atributos da ficha (PI): ${(quality.pi_missing_attributes ?? []).slice(0, 3).join(', ')}`,
        })
      }
      if (ftMissing > 0) {
        issues.push({
          code:     'FT_MISSING',
          area:     'attributes',
          severity: 'medium',
          message:  `Faltam ${ftMissing} atributos técnicos (FT): ${(quality.ft_missing_attributes ?? []).slice(0, 3).join(', ')}`,
        })
      }
      if (quality.has_exposure_penalty) {
        attrScore = Math.min(attrScore, 40)
        issues.push({ code: 'EXPOSURE_PENALTY', area: 'general', severity: 'critical', message: 'ML está penalizando exposição (atributos faltando)' })
      }
    } else {
      issues.push({ code: 'NO_QUALITY_SNAPSHOT', area: 'attributes', severity: 'info', message: 'Sem snapshot de qualidade ML (scanner ml-quality não rodou)' })
    }

    // Pictures
    const picsCount = (item.pictures ?? []).length
    let picsScore = 50
    if (picsCount === 0) {
      picsScore = 0
      issues.push({ code: 'PICS_NONE', area: 'pictures', severity: 'critical', message: 'Sem imagens' })
    } else if (picsCount < 3) {
      picsScore = 30
      issues.push({ code: 'PICS_FEW', area: 'pictures', severity: 'high', message: `Poucas imagens (${picsCount}/10 — ideal 6+)` })
    } else if (picsCount < 6) {
      picsScore = 65
      issues.push({ code: 'PICS_OK', area: 'pictures', severity: 'low', message: `${picsCount}/10 imagens — pode adicionar mais até 10` })
    } else {
      picsScore = 100
    }

    // Description não scoreio em v1 (eviting per-item GET call)
    const descScore = 50

    // Weighted: title 40% + attrs 40% + pics 20% (description ignorado em v1)
    const structural = Math.round(0.40 * titleScore + 0.40 * attrScore + 0.20 * picsScore)

    return {
      title:       titleScore,
      description: descScore,
      attributes:  attrScore,
      pictures:    picsScore,
      structural,
      issues,
    }
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private async upsertScore(
    orgId:    string,
    sellerId: number,
    itemId:   string,
    item:     NonNullable<MlBatchItem['body']>,
    score:    ReturnType<typeof this.computeStructuralScore>,
    visits30d:number | null,
    quality:  QualitySnapshotRow | undefined,
  ): Promise<boolean> {
    const row = {
      organization_id:               orgId,
      seller_id:                     sellerId,
      ml_item_id:                    itemId,
      title:                         item.title ?? null,
      title_length:                  (item.title ?? '').length,
      pictures_count:                (item.pictures ?? []).length,
      attributes_count:              quality ? (quality.all_filled_count ?? 0) : null,
      attributes_missing_required:   quality?.pi_missing_count ?? null,
      attributes_missing_recommended:quality?.ft_missing_count ?? null,
      has_description:               null,                                     // v1 não scoreia
      description_length:            null,
      listing_type_id:               item.listing_type_id ?? null,
      catalog_listing:               item.catalog_listing ?? false,
      status:                        item.status ?? null,
      price:                         item.price ?? null,
      sold_quantity:                 item.sold_quantity ?? null,
      visits_30d:                    visits30d,
      title_score:                   score.title,
      description_score:             score.description,
      attributes_score:              score.attributes,
      pictures_score:                score.pictures,
      structural_score:              score.structural,
      issues:                        score.issues,
      last_scanned_at:               new Date().toISOString(),
      updated_at:                    new Date().toISOString(),
    }
    const { error } = await supabaseAdmin
      .from('ml_listing_seo_scores')
      .upsert(row, { onConflict: 'organization_id,seller_id,ml_item_id' })
    if (error) {
      this.logger.warn(`[seo-scanner] upsert ${itemId}: ${error.message}`)
      return false
    }
    return true
  }

  private async upsertSeoLowTask(
    orgId:    string,
    sellerId: number,
    itemId:   string,
    item:     NonNullable<MlBatchItem['body']>,
    score:    ReturnType<typeof this.computeStructuralScore>,
    visits30d:number | null,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const severity = this.severityFromScore(score.structural)
    const priority = this.priorityFromScoreAndVisits(score.structural, visits30d, item.sold_quantity ?? 0)
    return this.upsertTask({
      orgId, sellerId, itemId,
      taskType:    'SEO_LOW',
      title:       'SEO baixo — anúncio precisa de ajustes',
      description: this.summarizeIssues(item, score, visits30d),
      severity,
      priority,
      currentValue: {
        structural_score: score.structural,
        title_score:      score.title,
        attributes_score: score.attributes,
        pictures_score:   score.pictures,
        visits_30d:       visits30d,
      },
      suggestedAction: 'Abrir Otimizador SEO IA pra revisar título, atributos e fotos',
      deeplink:        `https://eclick.app.br/dashboard/listings/seo-optimizer?mlbId=${itemId}`,
    })
  }

  private async upsertHighVisitsLowScoreTask(
    orgId:    string,
    sellerId: number,
    itemId:   string,
    item:     NonNullable<MlBatchItem['body']>,
    score:    ReturnType<typeof this.computeStructuralScore>,
    visits30d:number,
  ): Promise<'created' | 'updated' | 'skipped'> {
    return this.upsertTask({
      orgId, sellerId, itemId,
      taskType:    'SEO_HIGH_VISITS_LOW_SCORE',
      title:       'Alto tráfego e SEO médio — ROI quente',
      description: `${visits30d} visitas / 30d com score ${score.structural}/100. Otimizar agora maximiza conversão.`,
      severity:    'high',
      priority:    Math.min(100, 60 + Math.floor(visits30d / 50)),
      currentValue: {
        structural_score: score.structural,
        visits_30d:       visits30d,
        sold_quantity:    item.sold_quantity ?? 0,
      },
      suggestedAction: 'Otimizar SEO IA — tráfego está lá, basta melhorar a vitrine',
      deeplink:        `https://eclick.app.br/dashboard/listings/seo-optimizer?mlbId=${itemId}`,
    })
  }

  private async upsertTask(args: {
    orgId:           string
    sellerId:        number
    itemId:          string
    taskType:        'SEO_LOW' | 'SEO_HIGH_VISITS_LOW_SCORE'
    title:           string
    description:     string
    severity:        'critical' | 'high' | 'medium' | 'low'
    priority:        number
    currentValue:    Record<string, unknown>
    suggestedAction: string
    deeplink:        string
  }): Promise<'created' | 'updated' | 'skipped'> {
    const { data: existing } = await supabaseAdmin
      .from('ml_listing_tasks')
      .select('id, detection_count')
      .eq('organization_id', args.orgId)
      .eq('seller_id', args.sellerId)
      .eq('ml_item_id', args.itemId)
      .eq('task_type', args.taskType)
      .in('status', ['open', 'snoozed', 'in_progress'])
      .maybeSingle()

    if (existing) {
      const e = existing as { id: string; detection_count: number | null }
      await supabaseAdmin
        .from('ml_listing_tasks')
        .update({
          last_seen_at:    new Date().toISOString(),
          detection_count: (e.detection_count ?? 1) + 1,
          severity:        args.severity,
          priority_score:  args.priority,
          current_value:   args.currentValue,
          updated_at:      new Date().toISOString(),
        })
        .eq('id', e.id)
      return 'updated'
    }

    const { error } = await supabaseAdmin.from('ml_listing_tasks').insert({
      organization_id:   args.orgId,
      seller_id:         args.sellerId,
      ml_item_id:        args.itemId,
      task_type:         args.taskType,
      task_title:        args.title,
      task_description:  args.description,
      source:            'scanner_seo',
      severity:          args.severity,
      priority_score:    args.priority,
      impact_area:       ['exposure', 'sales'],
      current_value:     args.currentValue,
      suggested_action:  args.suggestedAction,
      deeplink_url:      args.deeplink,
      deeplink_module:   'listing_center',
      status:            'open',
    })
    if (error) {
      this.logger.warn(`[seo-scanner] insert task ${args.itemId}/${args.taskType}: ${error.message}`)
      return 'skipped'
    }
    return 'created'
  }

  /** Items cujo último score subiu ≥ 60 → fecha tasks SEO_LOW abertas. */
  private async autoResolveImproved(orgId: string, sellerId: number): Promise<number> {
    // 1. Items que agora têm score >= 60 (last scan >= 1h atrás pra evitar race)
    const { data: improved } = await supabaseAdmin
      .from('ml_listing_seo_scores')
      .select('ml_item_id')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .gte('structural_score', 60)
      .gt('last_scanned_at', new Date(Date.now() - 60 * 60_000).toISOString())

    const improvedIds = (improved ?? []).map(r => (r as { ml_item_id: string }).ml_item_id)
    if (improvedIds.length === 0) return 0

    const { data, error } = await supabaseAdmin
      .from('ml_listing_tasks')
      .update({
        status:           'resolved_auto',
        resolved_at:      new Date().toISOString(),
        resolution_notes: 'Score SEO melhorou (≥60) — auto-resolvida',
      })
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .eq('source', 'scanner_seo')
      .in('task_type', ['SEO_LOW', 'SEO_HIGH_VISITS_LOW_SCORE'])
      .eq('status', 'open')
      .in('ml_item_id', improvedIds)
      .select('id')

    if (error) {
      this.logger.warn(`[seo-scanner] auto-resolve: ${error.message}`)
      return 0
    }
    return data?.length ?? 0
  }

  // ── Lookups ──────────────────────────────────────────────────────────────

  private async fetchActiveItemIds(token: string, sellerId: number): Promise<string[]> {
    const ids: string[] = []
    let offset = 0
    const limit = 50
    const SAFETY_CAP = 5000
    while (offset < SAFETY_CAP) {
      try {
        const { data } = await axios.get(`${ML_BASE}/users/${sellerId}/items/search`, {
          headers: { Authorization: `Bearer ${token}` },
          params:  { status: 'active', limit, offset },
          timeout: 10_000,
        })
        const page = (data.results ?? []) as string[]
        if (page.length === 0) break
        ids.push(...page)
        if (page.length < limit) break
        offset += limit
      } catch (err) {
        this.logger.warn(`[seo-scanner] search offset=${offset}: ${(err as Error).message}`)
        break
      }
    }
    return ids
  }

  private async loadQualitySnapshots(
    orgId:    string,
    sellerId: number,
    itemIds:  string[],
  ): Promise<Map<string, QualitySnapshotRow>> {
    const map = new Map<string, QualitySnapshotRow>()
    if (itemIds.length === 0) return map
    // Lê em lotes de 200 (PostgREST limita IN array ~1k em chars)
    for (let i = 0; i < itemIds.length; i += 200) {
      const slice = itemIds.slice(i, i + 200)
      const { data, error } = await supabaseAdmin
        .from('ml_quality_snapshots')
        .select('ml_item_id, pi_missing_count, pi_filled_count, ft_missing_count, ft_filled_count, all_missing_count, all_filled_count, pi_missing_attributes, ft_missing_attributes, has_exposure_penalty')
        .eq('organization_id', orgId)
        .eq('seller_id', sellerId)
        .in('ml_item_id', slice)
      if (error) {
        this.logger.warn(`[seo-scanner] quality lookup: ${error.message}`)
        continue
      }
      for (const row of (data ?? []) as QualitySnapshotRow[]) {
        map.set(row.ml_item_id, row)
      }
    }
    return map
  }

  private async loadVisits(
    orgId:    string,
    sellerId: number,
    itemIds:  string[],
  ): Promise<Map<string, VisitsRow>> {
    const map = new Map<string, VisitsRow>()
    if (itemIds.length === 0) return map
    for (let i = 0; i < itemIds.length; i += 200) {
      const slice = itemIds.slice(i, i + 200)
      const { data, error } = await supabaseAdmin
        .from('ml_item_visits_period')
        .select('ml_item_id, period_days, total_visits, period_end')
        .eq('organization_id', orgId)
        .eq('seller_id', sellerId)
        .in('ml_item_id', slice)
        .order('period_end', { ascending: false })
      if (error) {
        this.logger.warn(`[seo-scanner] visits lookup: ${error.message}`)
        continue
      }
      // Mantém só o mais recente por item
      for (const row of (data ?? []) as VisitsRow[]) {
        if (!map.has(row.ml_item_id)) map.set(row.ml_item_id, row)
      }
    }
    return map
  }

  private normalizeVisitsTo30d(row: VisitsRow | undefined): number | null {
    if (!row) return null
    if (!row.period_days || row.period_days <= 0) return null
    return Math.round((row.total_visits / row.period_days) * 30)
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private severityFromScore(score: number): 'critical' | 'high' | 'medium' | 'low' {
    if (score < 30) return 'critical'
    if (score < 50) return 'high'
    if (score < 60) return 'medium'
    return 'low'
  }

  private priorityFromScoreAndVisits(score: number, visits: number | null, sold: number): number {
    // visits e sold quebram empate quando muitos anúncios têm score baixo
    const scorePenalty = 100 - score
    const trafficBoost = Math.min(40, Math.floor((visits ?? 0) / 10))
    const salesBoost   = Math.min(20, Math.floor(sold / 5))
    return Math.min(100, scorePenalty + trafficBoost + salesBoost)
  }

  private summarizeIssues(
    item:     NonNullable<MlBatchItem['body']>,
    score:    ReturnType<typeof this.computeStructuralScore>,
    visits:   number | null,
  ): string {
    const parts: string[] = [
      `Score ${score.structural}/100`,
      `título ${score.title}`,
      `atributos ${score.attributes}`,
      `fotos ${score.pictures}`,
    ]
    if (visits != null) parts.push(`${visits} visitas/30d`)
    const topIssue = score.issues.find(i => i.severity === 'critical' || i.severity === 'high')
    if (topIssue) parts.push(`→ ${topIssue.message}`)
    return parts.join(' · ').slice(0, 200)
  }
}
