import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'
import { ModelSourceRegistry } from './model-sources/model-source.registry'
import { type LicenseVerdict } from './model-sources/source.types'

/**
 * Radar de campeões (Peça 3) — multi-fonte via ModelSourceRegistry.
 *
 * O feed "em alta" oficial é travado por login → v1 = WATCHLIST: o lojista
 * semeia modelos, o sistema fotografa as métricas ao longo do tempo (via API
 * by-id, anônima) e rankeia por VELOCIDADE — downloads/prints ganhos por
 * semana, não pelo total acumulado (um modelo antigo com muito download pode
 * estar morto; um novo subindo rápido é o campeão). Champion Score prioriza
 * prints (uso real) sobre downloads. Cruza com o selo de licença (Peça 1/2)
 * pra não recomendar comprar o que não dá pra remodelar/vender.
 */

export type RadarDecision = 'observar' | 'comprar' | 'ignorar'

interface Snapshot { download_count: number; print_count: number; like_count: number; collection_count: number; captured_at: string }

export interface RadarItemView {
  id:                   string
  platform:             string
  external_id:          string
  title:                string | null
  cover_url:            string | null
  creator:              string | null
  source_url:           string | null
  license:              string | null
  verdict:              LicenseVerdict
  last_download_count:  number
  last_print_count:     number
  last_like_count:      number
  last_collection_count: number
  downloads_per_week:   number | null
  prints_per_week:      number | null
  champion_score:       number | null
  velocity_status:      'coletando' | 'ok'
  days_tracked:         number
  snapshots_count:      number
  decision:             RadarDecision
  ai_suggestion:        Record<string, unknown> | null
  notes:                string | null
  first_seen_at:        string
  last_checked_at:      string | null
}

interface WatchItemRow {
  id: string; organization_id: string; platform: string; external_id: string; title: string | null; cover_url: string | null
  creator: string | null; license: string | null; allow_recreation: boolean | null; source_url: string | null
  verdict: LicenseVerdict | null
  last_download_count: number; last_print_count: number; last_like_count: number; last_collection_count: number
  decision: RadarDecision; ai_suggestion: Record<string, unknown> | null; notes: string | null
  is_active: boolean; first_seen_at: string; last_checked_at: string | null
}

@Injectable()
export class MakerworldRadarService {
  private readonly logger = new Logger(MakerworldRadarService.name)

  constructor(
    private readonly sources: ModelSourceRegistry,
    private readonly llm: LlmService,
  ) {}

  private nowIso(): string { return new Date().toISOString() }

  /** Grava um snapshot das métricas atuais do item. */
  private async snapshot(orgId: string, itemId: string, m: { download_count: number; print_count: number; like_count: number; collection_count: number }): Promise<void> {
    await supabaseAdmin.from('mw_watch_snapshot').insert({
      organization_id: orgId, watch_item_id: itemId,
      download_count: m.download_count, print_count: m.print_count, like_count: m.like_count, collection_count: m.collection_count,
    }).then(() => {}, () => {})
  }

  /** Adiciona um modelo ao radar (ou reativa se já existia) + 1º snapshot. */
  async addToWatch(orgId: string, userId: string | null, url: string): Promise<RadarItemView> {
    const d = await this.sources.fetchByUrl(url)
    const { data, error } = await supabaseAdmin.from('mw_watch_item').upsert({
      organization_id: orgId, kind: 'design', platform: d.platform, external_id: d.external_id,
      title: d.title, cover_url: d.cover_url, creator: d.creator, license: d.license,
      allow_recreation: d.allow_recreation, source_url: d.source_url, verdict: d.verdict,
      last_download_count: d.download_count, last_print_count: d.print_count,
      last_like_count: d.like_count, last_collection_count: d.collection_count,
      is_active: true, last_checked_at: this.nowIso(), created_by: userId, updated_at: this.nowIso(),
    }, { onConflict: 'organization_id,platform,kind,external_id' }).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao adicionar ao radar: ${error?.message ?? 'sem dados'}`)
    const item = data as WatchItemRow
    await this.snapshot(orgId, item.id, d)
    const snaps = await this.snapshotsOf(orgId, [item.id])
    return this.viewOf(item, snaps.get(item.id) ?? [])
  }

  private async snapshotsOf(orgId: string, itemIds: string[]): Promise<Map<string, Snapshot[]>> {
    const out = new Map<string, Snapshot[]>()
    if (!itemIds.length) return out
    const { data } = await supabaseAdmin.from('mw_watch_snapshot')
      .select('watch_item_id, download_count, print_count, like_count, collection_count, captured_at')
      .eq('organization_id', orgId).in('watch_item_id', itemIds)
      .order('captured_at', { ascending: true })
    for (const r of (data ?? []) as Array<Snapshot & { watch_item_id: string }>) {
      const list = out.get(r.watch_item_id) ?? []
      list.push({ download_count: r.download_count, print_count: r.print_count, like_count: r.like_count, collection_count: r.collection_count, captured_at: r.captured_at })
      out.set(r.watch_item_id, list)
    }
    return out
  }

  /** Velocidade semanal a partir dos snapshots. Usa janela de ~7 dias quando há
   *  histórico; senão a média desde o início. Precisa de ≥2 snapshots e ≥0,5 dia. */
  private velocity(snaps: Snapshot[]): { dpw: number | null; ppw: number | null; days: number; status: 'coletando' | 'ok' } {
    if (snaps.length < 2) return { dpw: null, ppw: null, days: 0, status: 'coletando' }
    const last = snaps[snaps.length - 1]
    const lastT = new Date(last.captured_at).getTime()
    // baseline = snapshot mais antigo que ainda esteja a ≥5 dias do último (janela semanal); senão o 1º
    let base = snaps[0]
    for (let i = snaps.length - 2; i >= 0; i--) {
      const gap = (lastT - new Date(snaps[i].captured_at).getTime()) / 86400000
      if (gap >= 5) { base = snaps[i]; break }
    }
    const days = (lastT - new Date(base.captured_at).getTime()) / 86400000
    if (days < 0.5) return { dpw: null, ppw: null, days: Math.max(0, days), status: 'coletando' }
    const dpw = Math.max(0, Math.round(((last.download_count - base.download_count) / days) * 7))
    const ppw = Math.max(0, Math.round(((last.print_count - base.print_count) / days) * 7))
    return { dpw, ppw, days: Math.round(days * 10) / 10, status: 'ok' }
  }

  private viewOf(item: WatchItemRow, snaps: Snapshot[]): RadarItemView {
    // veredito gravado no add/refresh (platform-agnostic); fallback p/ linhas legadas
    const verdict: LicenseVerdict = item.verdict ?? { level: 'red', can_remodel: false, can_commercial: false, label: 'Licença não avaliada', reason: 'Atualize o item para reavaliar a licença.' }
    const v = this.velocity(snaps)
    // Champion Score: prints (uso real) pesam 2×; downloads 1×. null enquanto coleta.
    const champion = v.status === 'ok' && v.dpw != null && v.ppw != null ? v.dpw + v.ppw * 2 : null
    return {
      id: item.id, platform: item.platform ?? 'makerworld', external_id: item.external_id, title: item.title, cover_url: item.cover_url,
      creator: item.creator, source_url: item.source_url, license: item.license, verdict,
      last_download_count: item.last_download_count, last_print_count: item.last_print_count,
      last_like_count: item.last_like_count, last_collection_count: item.last_collection_count,
      downloads_per_week: v.dpw, prints_per_week: v.ppw, champion_score: champion,
      velocity_status: v.status, days_tracked: v.days, snapshots_count: snaps.length,
      decision: item.decision, ai_suggestion: item.ai_suggestion, notes: item.notes,
      first_seen_at: item.first_seen_at, last_checked_at: item.last_checked_at,
    }
  }

  /** Lista o radar ordenado por Champion Score (em coleta vai pro fim). */
  async list(orgId: string): Promise<RadarItemView[]> {
    const { data, error } = await supabaseAdmin.from('mw_watch_item')
      .select('*').eq('organization_id', orgId).eq('is_active', true)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    const items = (data ?? []) as WatchItemRow[]
    const snaps = await this.snapshotsOf(orgId, items.map(i => i.id))
    const views = items.map(i => this.viewOf(i, snaps.get(i.id) ?? []))
    return views.sort((a, b) => (b.champion_score ?? -1) - (a.champion_score ?? -1))
  }

  /** Re-fotografa 1 item (ou todos os ativos da org) lendo a API by-id. */
  async refresh(orgId: string, itemId?: string): Promise<{ refreshed: number; failed: number }> {
    let q = supabaseAdmin.from('mw_watch_item').select('id, platform, external_id, source_url').eq('organization_id', orgId).eq('is_active', true)
    if (itemId) q = q.eq('id', itemId)
    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    const items = (data ?? []) as Array<{ id: string; platform: string; external_id: string; source_url: string | null }>
    if (itemId && !items.length) throw new NotFoundException('Item do radar não encontrado')

    let refreshed = 0, failed = 0
    for (const it of items) {
      try {
        const d = await this.sources.fetchByPlatform(it.platform ?? 'makerworld', it.source_url || it.external_id)
        await this.snapshot(orgId, it.id, d)
        await supabaseAdmin.from('mw_watch_item').update({
          title: d.title, cover_url: d.cover_url, creator: d.creator, license: d.license, allow_recreation: d.allow_recreation, verdict: d.verdict,
          last_download_count: d.download_count, last_print_count: d.print_count,
          last_like_count: d.like_count, last_collection_count: d.collection_count,
          last_checked_at: this.nowIso(), updated_at: this.nowIso(),
        }).eq('id', it.id).eq('organization_id', orgId)
        refreshed++
      } catch (e) {
        failed++
        this.logger.warn(`[radar] refresh ${it.platform}/${it.external_id} falhou: ${(e as Error).message}`)
      }
    }
    return { refreshed, failed }
  }

  async setDecision(orgId: string, itemId: string, decision: RadarDecision, notes?: string): Promise<RadarItemView> {
    if (!['observar', 'comprar', 'ignorar'].includes(decision)) throw new BadRequestException('Decisão inválida')
    const patch: Record<string, unknown> = { decision, updated_at: this.nowIso() }
    if (notes !== undefined) patch.notes = notes?.trim() || null
    const { data, error } = await supabaseAdmin.from('mw_watch_item').update(patch)
      .eq('id', itemId).eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'não encontrado'}`)
    const item = data as WatchItemRow
    const snaps = await this.snapshotsOf(orgId, [item.id])
    return this.viewOf(item, snaps.get(item.id) ?? [])
  }

  async remove(orgId: string, itemId: string): Promise<{ removed: boolean }> {
    const { error } = await supabaseAdmin.from('mw_watch_item').update({ is_active: false, updated_at: this.nowIso() })
      .eq('id', itemId).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { removed: true }
  }

  /** Copiloto IA: recomenda comprar/observar/ignorar cruzando velocidade +
   *  licença + popularidade. On-demand (custo de token só quando o user pede). */
  async aiSuggest(orgId: string, itemId: string): Promise<{ decision: RadarDecision; confidence: number; rationale: string }> {
    const { data, error } = await supabaseAdmin.from('mw_watch_item').select('*')
      .eq('id', itemId).eq('organization_id', orgId).eq('is_active', true).maybeSingle()
    if (error || !data) throw new NotFoundException('Item do radar não encontrado')
    const item = data as WatchItemRow
    const snaps = await this.snapshotsOf(orgId, [item.id])
    const view = this.viewOf(item, snaps.get(item.id) ?? [])

    const dossie = {
      titulo: view.title, criador: view.creator, licenca: view.license,
      pode_remodelar: view.verdict.can_remodel, pode_vender: view.verdict.can_commercial, veredito: view.verdict.level,
      downloads_total: view.last_download_count, prints_total: view.last_print_count, likes: view.last_like_count, colecoes: view.last_collection_count,
      downloads_por_semana: view.downloads_per_week, prints_por_semana: view.prints_per_week, champion_score: view.champion_score,
      dias_em_observacao: view.days_tracked, velocidade: view.velocity_status,
    }
    const out = await this.llm.generateText({
      orgId,
      feature: 'makerworld_radar_decision',
      systemPrompt: RADAR_SYSTEM_PROMPT,
      userPrompt: `Avalie este modelo do MakerWorld para a fábrica de impressão 3D:\n${JSON.stringify(dossie, null, 2)}\n\nResponda só com JSON: {"decision":"comprar|observar|ignorar","confidence":0..1,"rationale":"1-2 frases em PT-BR"}`,
      maxTokens: 400, temperature: 0.3, jsonMode: true,
    })
    const parsed = parseJsonLoose(out.text) as { decision?: string; confidence?: number; rationale?: string } | null
    const decision: RadarDecision = parsed?.decision === 'comprar' || parsed?.decision === 'ignorar' ? parsed.decision : 'observar'
    const result = {
      decision,
      confidence: typeof parsed?.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      rationale: typeof parsed?.rationale === 'string' ? parsed.rationale : 'Sem racional.',
    }
    await supabaseAdmin.from('mw_watch_item').update({ ai_suggestion: { ...result, at: this.nowIso(), cost_usd: out.costUsd }, updated_at: this.nowIso() })
      .eq('id', itemId).eq('organization_id', orgId)
    return result
  }

  // ══ Watchlist de criadores (Fase E) ════════════════════════════════
  /** Segue um criador (valida listando os modelos dele) + devolve a prévia. */
  async addCreator(orgId: string, userId: string | null, platform: string, handle: string): Promise<{ creator: TrackedCreator; models: import('./model-sources/source.types').SourceModel[] }> {
    const nick = (handle ?? '').replace(/^@/, '').trim()
    if (!nick) throw new BadRequestException('Informe o nick do criador.')
    const models = await this.sources.listByCreator(platform, nick, 24)
    const displayName = models.find(m => m.creator)?.creator ?? nick
    const { data, error } = await supabaseAdmin.from('mw_tracked_creator').upsert({
      organization_id: orgId, platform, handle: nick, display_name: displayName,
      last_model_count: models.length, is_active: true, created_by: userId, updated_at: this.nowIso(),
    }, { onConflict: 'organization_id,platform,handle' }).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao seguir criador: ${error?.message ?? 'sem dados'}`)
    return { creator: data as TrackedCreator, models }
  }

  async listCreators(orgId: string): Promise<TrackedCreator[]> {
    const { data, error } = await supabaseAdmin.from('mw_tracked_creator')
      .select('*').eq('organization_id', orgId).eq('is_active', true).order('created_at', { ascending: false })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []) as TrackedCreator[]
  }

  /** Modelos do criador AO VIVO (ranqueados por popularidade, com veredito). */
  async creatorModels(orgId: string, creatorId: string): Promise<import('./model-sources/source.types').SourceModel[]> {
    const { data } = await supabaseAdmin.from('mw_tracked_creator').select('platform, handle')
      .eq('id', creatorId).eq('organization_id', orgId).eq('is_active', true).maybeSingle()
    if (!data) throw new NotFoundException('Criador não encontrado')
    const c = data as { platform: string; handle: string }
    const models = await this.sources.listByCreator(c.platform, c.handle, 24)
    await supabaseAdmin.from('mw_tracked_creator').update({ last_model_count: models.length, updated_at: this.nowIso() })
      .eq('id', creatorId).eq('organization_id', orgId)
    return models
  }

  async removeCreator(orgId: string, creatorId: string): Promise<{ removed: boolean }> {
    const { error } = await supabaseAdmin.from('mw_tracked_creator').update({ is_active: false, updated_at: this.nowIso() })
      .eq('id', creatorId).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { removed: true }
  }

  // ══ Feed "em alta" / descoberta (Fase D) ═══════════════════════════
  async discover(platform: string, opts: { commercialOnly?: boolean; limit?: number } = {}): Promise<import('./model-sources/source.types').SourceModel[]> {
    return this.sources.discover(platform, { commercialOnly: opts.commercialOnly, limit: opts.limit ?? 24 })
  }
}

export interface TrackedCreator {
  id: string; organization_id: string; platform: string; handle: string
  display_name: string | null; is_active: boolean; last_model_count: number | null
  notes: string | null; created_at: string; updated_at: string
}

const RADAR_SYSTEM_PROMPT = `Você é um analista de produtos para uma fábrica de impressão 3D que revende modelos.
Decida se vale "comprar" (priorizar para remodelar e vender), "observar" (acompanhar mais) ou "ignorar".
Regras de ouro:
- VELOCIDADE manda mais que o total acumulado: prints/semana e downloads/semana subindo = campeão. Total alto mas estagnado = morto.
- LICENÇA é eliminatória para vender: se pode_vender=false ou pode_remodelar=false, NUNCA recomende "comprar" (no máximo "observar"), porque vender exporia juridicamente.
- prints valem mais que downloads (uso real vs. curiosidade).
- Se ainda está em coleta (sem velocidade), prefira "observar".
Seja direto e conservador.`

function parseJsonLoose(text: string): unknown {
  const trimmed = (text ?? '').trim()
  try { return JSON.parse(trimmed) } catch { /* continua */ }
  const m = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (m) { try { return JSON.parse(m[1]) } catch { /* continua */ } }
  const open = trimmed.indexOf('{'), close = trimmed.lastIndexOf('}')
  if (open >= 0 && close > open) { try { return JSON.parse(trimmed.slice(open, close + 1)) } catch { /* continua */ } }
  return null
}
