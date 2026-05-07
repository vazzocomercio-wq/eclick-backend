import { Injectable, BadRequestException, NotFoundException, Logger, Optional } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { EventsGateway } from '../events/events.gateway'
import {
  type AlertSignal, type AlertSignalStatus, type AnalyzerName, type SignalDraft,
  severityFromScore,
} from './analyzers/analyzers.types'

/**
 * Persistência e queries de alert_signals.
 *
 * insertMany() é o entry-point usado pelos analyzers — recebe drafts e
 * grava em batch. Garante severity coerente com score se severity vier ausente
 * ou inconsistente (override prática vs spec: severity sempre derivada de
 * severityFromScore() quando não fornecida).
 */
@Injectable()
export class AlertSignalsService {
  private readonly logger = new Logger(AlertSignalsService.name)

  /**
   * EventsGateway é opcional pra evitar dependência circular com módulos
   * que ainda não importam EventsModule. Quando presente, emite
   * `intelligence:alert` em real-time além da persistência.
   */
  constructor(@Optional() private readonly events?: EventsGateway) {}

  async insertMany(orgId: string, drafts: SignalDraft[]): Promise<AlertSignal[]> {
    if (drafts.length === 0) return []

    const rows = drafts.map(d => ({
      organization_id: orgId,
      analyzer:        d.analyzer,
      category:        d.category,
      severity:        d.severity ?? severityFromScore(d.score),
      score:           Math.max(0, Math.min(100, Math.round(d.score))),
      entity_type:     d.entity_type ?? null,
      entity_id:       d.entity_id   ?? null,
      entity_name:     d.entity_name ?? null,
      data:            d.data ?? {},
      summary_pt:      d.summary_pt,
      suggestion_pt:   d.suggestion_pt ?? null,
      expires_at:      d.expires_at   ?? null,
      status:          'new',
    }))

    const { data, error } = await supabaseAdmin
      .from('alert_signals')
      .insert(rows)
      .select()

    if (error) throw new BadRequestException(error.message)

    this.logger.log(`[insertMany] org=${orgId} analyzer=${drafts[0]?.analyzer} count=${data?.length ?? 0}`)

    // Emite Socket.IO `intelligence:alert` por signal — UI faz toast persistente
    // + atualiza badge de alertas no menu lateral.
    if (this.events) {
      for (const sig of (data ?? []) as AlertSignal[]) {
        try {
          this.events.emitToOrg(orgId, 'intelligence:alert', {
            id:         sig.id,
            analyzer:   sig.analyzer,
            category:   sig.category,
            severity:   sig.severity,
            score:      sig.score,
            entity_type: sig.entity_type,
            entity_id:  sig.entity_id,
            entity_name: sig.entity_name,
            summary:    sig.summary_pt,
            suggestion: sig.suggestion_pt,
            data:       sig.data,
            created_at: sig.created_at,
          })
        } catch (e) {
          this.logger.warn(`[insertMany.emit] sig=${sig.id}: ${(e as Error).message}`)
        }
      }
    }

    return (data ?? []) as AlertSignal[]
  }

  async list(orgId: string, filters: {
    analyzer?:  AnalyzerName
    status?:    AlertSignalStatus
    min_score?: number
    limit?:     number
  } = {}): Promise<AlertSignal[]> {
    let q = supabaseAdmin
      .from('alert_signals')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(filters.limit ?? 100)

    if (filters.analyzer)              q = q.eq('analyzer', filters.analyzer)
    if (filters.status)                q = q.eq('status', filters.status)
    if (filters.min_score !== undefined) q = q.gte('score', filters.min_score)

    const { data, error } = await q
    if (error) throw new BadRequestException(error.message)
    return (data ?? []) as AlertSignal[]
  }

  async findOne(orgId: string, id: string): Promise<AlertSignal> {
    const { data, error } = await supabaseAdmin
      .from('alert_signals')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new BadRequestException(error.message)
    if (!data)  throw new NotFoundException(`Signal ${id} não encontrado`)
    return data as AlertSignal
  }

  async updateStatus(orgId: string, id: string, status: AlertSignalStatus): Promise<AlertSignal> {
    const { data, error } = await supabaseAdmin
      .from('alert_signals')
      .update({ status })
      .eq('organization_id', orgId)
      .eq('id', id)
      .select()
      .single()
    if (error) throw new BadRequestException(error.message)
    return data as AlertSignal
  }

  /**
   * Encontra signals recentes pro mesmo (entity_type, entity_id) — usado por
   * analyzers pra evitar duplicar sinal idêntico (ex: estoque baixo da mesma
   * SKU 2 vezes no mesmo dia).
   */
  async findRecentByEntity(
    orgId:       string,
    entityType:  string,
    entityId:    string,
    sinceMinutes = 60 * 24, // 24h default
  ): Promise<AlertSignal[]> {
    const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString()
    const { data, error } = await supabaseAdmin
      .from('alert_signals')
      .select('*')
      .eq('organization_id', orgId)
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .gte('created_at', since)
    if (error) throw new BadRequestException(error.message)
    return (data ?? []) as AlertSignal[]
  }
}
