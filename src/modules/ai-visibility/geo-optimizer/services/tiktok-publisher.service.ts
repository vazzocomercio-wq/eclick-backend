import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../../../common/supabase'
import { TikTokShopService } from '../../../tiktok-shop/tiktok-shop.service'
import { GeoTelemetryService } from '../../geo-score/services/geo-telemetry.service'
import { TitleVariation } from '../../shared/types'

const DAILY_CAP = 5 // salvaguarda: máx 5 applies/dia sem confirm_batch_expansion

/** Extrai o tts_product_id da URL sintética (https://shop.tiktok.com/product/<id>). */
function extractTtId(url: string): string | null {
  const m = url.match(/product\/(\d{6,})/i)
  return m ? m[1] : null
}

/** Converte o texto plano da descrição reescrita pro HTML simples que o TikTok
 *  Shop espera (parágrafos). Escapa HTML e NÃO injeta links/scripts (regras da
 *  plataforma). Quebra dupla = parágrafo; quebra simples = <br/>. */
function toTikTokHtml(text: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
  if (blocks.length === 0) return ''
  return blocks.map((b) => `<p>${esc(b).replace(/\n/g, '<br/>')}</p>`).join('')
}

/**
 * Publica a otimização GEO de volta no anúncio real do TikTok Shop via
 * partial_edit (atômico — só título/descrição mudam, o resto fica intacto).
 * ALTO RISCO: mesmas salvaguardas do ML — cap diário, versionamento (rollback),
 * aplica só com confirmação explícita. Espelha o MlPublisherService.
 */
@Injectable()
export class TiktokPublisherService {
  private readonly logger = new Logger(TiktokPublisherService.name)

  constructor(
    private readonly tiktok:    TikTokShopService,
    private readonly telemetry: GeoTelemetryService,
  ) {}

  /** Aplica a variação escolhida no anúncio TikTok. Não aplica se o cap estourar. */
  async apply(input: {
    orgId: string; userId: string; optimizerId: string; variant: 'A' | 'B' | 'C'; confirmBatchExpansion?: boolean
  }): Promise<{ ok: true; versionId: string; listingId: string; titleApplied: boolean; titleLocked: boolean }> {
    const opt = await this.loadOptimizer(input.orgId, input.optimizerId)
    if (opt.status === 'applied') throw new BadRequestException('Esta otimização já foi aplicada.')

    const productId = extractTtId(opt.url)
    if (!productId) throw new BadRequestException('URL de produto TikTok Shop inválida.')

    // Salvaguarda #1 — cap diário (compartilhado com o ML).
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
    const descNewHtml = toTikTokHtml(opt.description_new ?? '')

    // Estado atual (pra rollback) — lido AO VIVO do TikTok.
    const cur = await this.tiktok.getProductEditable(input.orgId, productId)
    if (!cur) throw new BadRequestException('Não consegui ler o produto no TikTok Shop (reconecte a loja).')
    const titleOld = cur.title
    const descOld  = cur.description

    // Edição parcial atômica: título + descrição. Se a API recusar, NADA muda.
    const willChangeTitle = !!(titleNew && titleNew !== titleOld)
    const willChangeDesc  = !!(descNewHtml && descNewHtml !== descOld)
    if (!willChangeTitle && !willChangeDesc) {
      throw new BadRequestException('O título e a descrição já estão iguais ao otimizado — nada a publicar.')
    }
    await this.tiktok.partialEditProduct(input.orgId, productId, {
      title:       willChangeTitle ? titleNew : undefined,
      description: willChangeDesc  ? descNewHtml : undefined,
    })

    const versionId = await this.recordVersion({
      orgId: input.orgId, optimizerId: input.optimizerId, listingId: productId, platform: opt.platform,
      titleOld, titleNew, descOld, descNew: descNewHtml, userId: input.userId, wasRollback: false,
    })

    // Re-importa o detalhe → atualiza o espelho tiktok_shop_products.raw (não-fatal).
    await this.tiktok.syncProductById(input.orgId, productId).catch(() => {})

    await supabaseAdmin.from('ai_optimizer_results')
      .update({ status: 'applied', applied_at: new Date().toISOString() }).eq('id', input.optimizerId)

    await this.telemetry.emit({
      orgId: input.orgId, userId: input.userId, jobId: input.optimizerId, feature: 'geo_optimizer',
      eventName: 'geo_optimizer.applied_to_marketplace',
      properties: { listing_id: productId, platform: 'tiktok_shop', variant: input.variant, score_before: opt.geo_score, version_id: versionId, title_applied: willChangeTitle },
    })
    this.logger.log(`[tt-publisher] APLICADO product=${productId} variante=${input.variant} título=${willChangeTitle ? 'mudou' : 'igual'} version=${versionId}`)
    return { ok: true, versionId, listingId: productId, titleApplied: willChangeTitle, titleLocked: false }
  }

  /** Volta o anúncio TikTok pro título/descrição anteriores ao último apply. */
  async rollback(input: { orgId: string; userId: string; optimizerId: string; reason?: string }): Promise<{ ok: true; listingId: string }> {
    const { data: ver } = await supabaseAdmin
      .from('ai_optimizer_versions')
      .select('id, listing_id, platform, title_old, description_old, changed_at')
      .eq('org_id', input.orgId).eq('optimizer_id', input.optimizerId).eq('was_rollback', false)
      .order('changed_at', { ascending: false }).limit(1).maybeSingle()
    if (!ver) throw new BadRequestException('Não há versão aplicada pra reverter.')
    const v = ver as { id: string; listing_id: string; platform: string; title_old: string; description_old: string; changed_at: string }

    await this.tiktok.partialEditProduct(input.orgId, v.listing_id, {
      title:       v.title_old || undefined,
      description: v.description_old || undefined,
    })
    await this.tiktok.syncProductById(input.orgId, v.listing_id).catch(() => {})

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
    this.logger.log(`[tt-publisher] ROLLBACK product=${v.listing_id}`)
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
    let geo_score: number | null = null
    if (opt.job_id) {
      const { data: r } = await supabaseAdmin.from('ai_audit_results').select('geo_score').eq('job_id', opt.job_id as string).maybeSingle()
      geo_score = (r as { geo_score?: number } | null)?.geo_score ?? null
    }
    return { ...opt, geo_score } as {
      id: string; url: string; platform: string; title_variations: unknown; description_new: string | null
      description_old: string | null; status: string; job_id: string | null; geo_score: number | null
    }
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
