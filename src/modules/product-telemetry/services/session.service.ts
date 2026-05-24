import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Gerencia as sessões de uso (telemetry_sessions). Uma sessão agrupa os
 * eventos de uma visita ao dashboard. É criada de forma idempotente no
 * primeiro batch e fechada pelo client (end-session) ou pelo rollup worker.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name)

  /** Cria a linha de sessão se ainda não existir (idempotente por id). */
  async ensure(input: {
    orgId:       string
    userId:      string
    sessionId:   string
    deviceType?: string
  }): Promise<void> {
    if (!UUID_RE.test(input.sessionId)) return
    const { error } = await supabaseAdmin
      .from('telemetry_sessions')
      .upsert(
        {
          id:          input.sessionId,
          org_id:      input.orgId,
          user_id:     input.userId,
          device_type: (input.deviceType ?? '').toString().trim().slice(0, 20) || null,
        },
        { onConflict: 'id', ignoreDuplicates: true },
      )
    if (error) this.logger.warn(`[session.ensure] ${error.message}`)
  }

  /**
   * Fecha a sessão: calcula duration_s, events_count e modules_visited a
   * partir dos eventos reais (fonte da verdade — evita corrida de contador).
   * Escopado por user_id pra ninguém fechar sessão alheia.
   */
  async end(input: { orgId: string; userId: string; sessionId: string }): Promise<{ ended: boolean }> {
    if (!UUID_RE.test(input.sessionId)) return { ended: false }

    const { data: session } = await supabaseAdmin
      .from('telemetry_sessions')
      .select('id, started_at')
      .eq('id', input.sessionId)
      .eq('user_id', input.userId)
      .maybeSingle()
    if (!session) return { ended: false }

    // Agrega os eventos da sessão pra fechar com números reais.
    const { data: events } = await supabaseAdmin
      .from('telemetry_events')
      .select('module, created_at')
      .eq('session_id', input.sessionId)
      .eq('user_id', input.userId)
      .order('created_at', { ascending: false })
      .limit(5000)

    const rows = (events ?? []) as Array<{ module: string; created_at: string }>
    const startedAt = new Date((session as { started_at: string }).started_at).getTime()
    const lastEventAt = rows.length ? new Date(rows[0].created_at).getTime() : Date.now()
    const durationS = Math.max(0, Math.round((lastEventAt - startedAt) / 1000))
    const modulesVisited = [...new Set(rows.map(r => r.module).filter(Boolean))]

    const { error } = await supabaseAdmin
      .from('telemetry_sessions')
      .update({
        ended_at:        new Date().toISOString(),
        duration_s:      durationS,
        events_count:    rows.length,
        modules_visited: modulesVisited,
      })
      .eq('id', input.sessionId)
      .eq('user_id', input.userId)
    if (error) {
      this.logger.warn(`[session.end] ${error.message}`)
      return { ended: false }
    }
    return { ended: true }
  }
}
