import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../../common/supabase'
import { MercadolivreService } from '../../../mercadolivre/mercadolivre.service'
import { GeoTelemetryService } from '../../geo-score/services/geo-telemetry.service'
import { BaselineService } from './baseline.service'
import { TitleVariation } from '../../shared/types'

const DAILY_CAP = 5 // salvaguarda #1: máx 5 applies/dia sem confirm_batch_expansion

function extractMlId(url: string): string | null {
  const m = url.match(/MLB-?(\d{6,})(?![\w])/i)
  if (m && !/MLB[UAB]/i.test(m[0])) return `MLB${m[1]}`
  const pdp = url.match(/item_id[:=]MLB-?(\d{6,})/i)
  return pdp ? `MLB${pdp[1]}` : null
}

/**
 * Publica a otimização nos anúncios reais do ML (PUT items/{id}). ALTO RISCO —
 * só roda no piloto controlado, com salvaguardas: cap diário, versionamento
 * (rollback), snapshot de baseline. Usa o token da CONTA DONA do anúncio.
 */
@Injectable()
export class MlPublisherService {
  private readonly logger = new Logger(MlPublisherService.name)

  constructor(
    private readonly mercadolivre: MercadolivreService,
    private readonly baseline:     BaselineService,
    private readonly telemetry:    GeoTelemetryService,
  ) {}

  /** Aplica a variação escolhida no ML. Não aplica se o cap diário estourar. */
  async apply(input: {
    orgId: string; userId: string; optimizerId: string; variant: 'A' | 'B' | 'C'; confirmBatchExpansion?: boolean
  }): Promise<{ ok: true; versionId: string; listingId: string; titleApplied: boolean; titleLocked: boolean }> {
    const opt = await this.loadOptimizer(input.orgId, input.optimizerId)
    if (opt.status === 'applied') throw new BadRequestException('Esta otimização já foi aplicada.')

    const itemId = extractMlId(opt.url)
    if (!itemId) throw new BadRequestException('Só publicação no Mercado Livre por enquanto (URL inválida).')

    // Salvaguarda #1 — cap diário.
    const today = new Date().toISOString().slice(0, 10)
    const { count } = await supabaseAdmin
      .from('ai_optimizer_versions')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', input.orgId).eq('was_rollback', false).gte('changed_at', `${today}T00:00:00Z`)
    if ((count ?? 0) >= DAILY_CAP && !input.confirmBatchExpansion) {
      throw new BadRequestException(`Cap de ${DAILY_CAP} otimizações/dia atingido. Use ?confirm_batch_expansion=true pra liberar mais (revise antes).`)
    }

    const variation = (opt.title_variations as TitleVariation[]).find(v => v.variant === input.variant)
    if (!variation?.title) throw new BadRequestException(`Variação ${input.variant} não encontrada no rascunho.`)
    const titleNew = variation.title
    const descNew  = opt.description_new ?? ''

    // Token da conta DONA do anúncio (multi-conta).
    const { token } = await this.ownerToken(input.orgId, itemId)
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

    // Estado atual (pra rollback) + regra de título do ML.
    const { title: titleOld, soldQty } = await this.currentItem(itemId, headers)
    const descOld  = await this.currentDescription(itemId, headers)
    // ⚠️ ML trava o título de anúncios COM vendas (erro 374). Nesses, só descrição.
    const canChangeTitle = soldQty === 0
    let appliedTitle = false
    try {
      if (canChangeTitle && titleNew && titleNew !== titleOld) {
        await axios.put(`https://api.mercadolibre.com/items/${itemId}`, { title: titleNew }, { headers, timeout: 15_000 })
        appliedTitle = true
      }
      await axios.put(`https://api.mercadolibre.com/items/${itemId}/description`, { plain_text: descNew }, { headers, timeout: 15_000 })
    } catch (e) {
      const ax = e as { response?: { status?: number; data?: unknown }; message?: string }
      this.logger.error(`[ml-publisher] APPLY FALHOU item=${itemId} status=${ax.response?.status} body=${JSON.stringify(ax.response?.data ?? null)} msg=${ax.message}`)
      throw new BadRequestException(`Falha ao publicar no ML (${ax.response?.status ?? '?'}). Confira o anúncio.`)
    }
    const effectiveTitleNew = appliedTitle ? titleNew : titleOld // título não muda se travado

    const versionId = await this.recordVersion({
      orgId: input.orgId, optimizerId: input.optimizerId, listingId: itemId, platform: opt.platform,
      titleOld, titleNew: effectiveTitleNew, descOld, descNew, userId: input.userId, wasRollback: false,
    })

    // Baseline (base do ImpactTracker).
    const snapshot = await this.baseline.capture({ orgId: input.orgId, listingId: itemId, productId: opt.product_id, geoScore: opt.geo_score, token })
    const { data: bl } = await supabaseAdmin.from('ai_optimizer_baselines')
      .insert({ org_id: input.orgId, optimizer_id: input.optimizerId, version_id: versionId, listing_id: itemId, snapshot_json: snapshot })
      .select('id').single()

    await supabaseAdmin.from('ai_optimizer_results')
      .update({ status: 'applied', applied_at: new Date().toISOString() }).eq('id', input.optimizerId)

    await this.telemetry.emit({
      orgId: input.orgId, userId: input.userId, jobId: input.optimizerId, feature: 'geo_optimizer',
      eventName: 'geo_optimizer.applied_to_marketplace',
      properties: { listing_id: itemId, platform: opt.platform, variant: input.variant, score_before: opt.geo_score, version_id: versionId, baseline_snapshot_id: (bl as { id?: string } | null)?.id ?? null, title_applied: appliedTitle, title_locked: !canChangeTitle },
    })
    this.logger.log(`[ml-publisher] APLICADO item=${itemId} variante=${input.variant} título=${appliedTitle ? 'mudou' : 'TRAVADO(vendas)'} version=${versionId}`)
    return { ok: true, versionId, listingId: itemId, titleApplied: appliedTitle, titleLocked: !canChangeTitle }
  }

  /** Volta o anúncio pro título/descrição anteriores ao último apply. */
  async rollback(input: { orgId: string; userId: string; optimizerId: string; reason?: string }): Promise<{ ok: true; listingId: string }> {
    const { data: ver } = await supabaseAdmin
      .from('ai_optimizer_versions')
      .select('id, listing_id, platform, title_old, description_old, changed_at')
      .eq('org_id', input.orgId).eq('optimizer_id', input.optimizerId).eq('was_rollback', false)
      .order('changed_at', { ascending: false }).limit(1).maybeSingle()
    if (!ver) throw new BadRequestException('Não há versão aplicada pra reverter.')
    const v = ver as { id: string; listing_id: string; platform: string; title_old: string; description_old: string; changed_at: string }

    const { token } = await this.ownerToken(input.orgId, v.listing_id)
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    // Mesma trava: só reverte o título se for mudável (sem venda) E tiver mudado.
    const { title: curTitle, soldQty } = await this.currentItem(v.listing_id, headers)
    try {
      if (soldQty === 0 && v.title_old && v.title_old !== curTitle) {
        await axios.put(`https://api.mercadolibre.com/items/${v.listing_id}`, { title: v.title_old }, { headers, timeout: 15_000 })
      }
      await axios.put(`https://api.mercadolibre.com/items/${v.listing_id}/description`, { plain_text: v.description_old ?? '' }, { headers, timeout: 15_000 })
    } catch (e) {
      const ax = e as { response?: { status?: number }; message?: string }
      this.logger.error(`[ml-publisher] ROLLBACK FALHOU item=${v.listing_id} status=${ax.response?.status} msg=${ax.message}`)
      throw new BadRequestException(`Falha no rollback (${ax.response?.status ?? '?'}). Confira o anúncio manualmente.`)
    }

    await this.recordVersion({
      orgId: input.orgId, optimizerId: input.optimizerId, listingId: v.listing_id, platform: v.platform,
      titleOld: '', titleNew: v.title_old, descOld: '', descNew: v.description_old, userId: input.userId, wasRollback: true,
    })
    await supabaseAdmin.from('ai_optimizer_results')
      .update({ status: 'rolled_back', rolled_back_at: new Date().toISOString() }).eq('id', input.optimizerId)

    const daysSince = Math.round((Date.now() - new Date(v.changed_at).getTime()) / 86400_000)
    await this.telemetry.emit({
      orgId: input.orgId, userId: input.userId, jobId: input.optimizerId, feature: 'geo_optimizer',
      eventName: 'geo_optimizer.rolled_back',
      properties: { listing_id: v.listing_id, version_id: v.id, days_since_apply: daysSince, reason: input.reason ?? null },
    })
    this.logger.log(`[ml-publisher] ROLLBACK item=${v.listing_id}`)
    return { ok: true, listingId: v.listing_id }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async loadOptimizer(orgId: string, optimizerId: string) {
    const { data } = await supabaseAdmin
      .from('ai_optimizer_results')
      .select('id, url, platform, title_variations, description_new, description_old, status, job_id')
      .eq('id', optimizerId).eq('org_id', orgId).maybeSingle()
    if (!data) throw new BadRequestException('Otimização não encontrada.')
    const opt = data as Record<string, unknown>
    // geo_score + product_id do listing (pro baseline).
    let geo_score: number | null = null
    let product_id: string | null = null
    if (opt.job_id) {
      const { data: r } = await supabaseAdmin.from('ai_audit_results').select('geo_score').eq('job_id', opt.job_id as string).maybeSingle()
      geo_score = (r as { geo_score?: number } | null)?.geo_score ?? null
    }
    const { data: pl } = await supabaseAdmin.from('product_listings').select('product_id').eq('listing_permalink', opt.url as string).maybeSingle()
    product_id = (pl as { product_id?: string } | null)?.product_id ?? null
    return { ...opt, geo_score, product_id } as {
      id: string; url: string; platform: string; title_variations: unknown; description_new: string | null
      description_old: string | null; status: string; job_id: string | null; geo_score: number | null; product_id: string | null
    }
  }

  private async ownerToken(orgId: string, itemId: string): Promise<{ token: string }> {
    // Descobre o seller dono via /items/{id} (com qualquer token da org) → token dele.
    const tokens = await this.mercadolivre.getAllTokensForOrg(orgId)
    for (const { token } of tokens) {
      try {
        const { data } = await axios.get(`https://api.mercadolibre.com/items/${itemId}?attributes=seller_id`, { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000 })
        const sellerId = Number((data as { seller_id?: number }).seller_id)
        if (sellerId) {
          const owner = await this.mercadolivre.getTokenForOrg(orgId, sellerId)
          return { token: owner.token }
        }
      } catch { /* tenta o próximo token */ }
    }
    throw new BadRequestException('Não consegui resolver a conta dona do anúncio (reconecte o Mercado Livre).')
  }

  private async currentItem(itemId: string, headers: Record<string, string>): Promise<{ title: string; soldQty: number }> {
    try {
      const { data } = await axios.get(`https://api.mercadolibre.com/items/${itemId}?attributes=title,sold_quantity`, { headers, timeout: 10_000 })
      const d = data as { title?: string; sold_quantity?: number }
      return { title: String(d.title ?? ''), soldQty: Number(d.sold_quantity ?? 0) || 0 }
    } catch { return { title: '', soldQty: 0 } }
  }
  private async currentDescription(itemId: string, headers: Record<string, string>): Promise<string> {
    try { const { data } = await axios.get(`https://api.mercadolibre.com/items/${itemId}/description`, { headers, timeout: 10_000 }); return String((data as { plain_text?: string }).plain_text ?? '') } catch { return '' }
  }

  private async recordVersion(v: {
    orgId: string; optimizerId: string; listingId: string; platform: string
    titleOld: string; titleNew: string; descOld: string; descNew: string; userId: string; wasRollback: boolean
  }): Promise<string> {
    const { data: last } = await supabaseAdmin
      .from('ai_optimizer_versions').select('version_number')
      .eq('org_id', v.orgId).eq('listing_id', v.listingId)
      .order('version_number', { ascending: false }).limit(1).maybeSingle()
    const nextNum = (((last as { version_number?: number } | null)?.version_number) ?? 0) + 1
    const { data, error } = await supabaseAdmin.from('ai_optimizer_versions').insert({
      org_id: v.orgId, optimizer_id: v.optimizerId, listing_id: v.listingId, platform: v.platform,
      version_number: nextNum, title_old: v.titleOld, title_new: v.titleNew,
      description_old: v.descOld, description_new: v.descNew, changed_by_user_id: v.userId, was_rollback: v.wasRollback,
    }).select('id').single()
    if (error || !data) throw new BadRequestException(`Falha ao registrar versão: ${error?.message ?? 'erro'}`)
    return (data as { id: string }).id
  }
}
