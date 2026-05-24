import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { SessionService } from './session.service'

const PAGE = 1000
const SESSION_IDLE_MS = 30 * 60 * 1000

interface RawRow {
  org_id:      string
  user_id:     string
  session_id:  string
  module:      string
  event_name:  string
  feature:     string | null
  duration_ms: number | null
  created_at:  string
}

interface DailyBucket {
  date:          string
  org_id:        string
  user_id:       string
  module:        string
  visits:        number
  total_time_s:  number
  events_count:  number
  features:      Set<string>
  last_event_at: string
}

/**
 * Agrega os eventos brutos em telemetry_events_daily e fecha sessões inativas.
 * Roda a cada 15min. Re-agrega as últimas 48h a cada execução (idempotente via
 * upsert na PK), então não precisa rastrear last_processed_id pro volume atual.
 */
@Injectable()
export class RollupService {
  private readonly logger = new Logger(RollupService.name)

  constructor(private readonly sessions: SessionService) {}

  @Cron('*/15 * * * *', { name: 'telemetry-rollup' })
  async scheduled() {
    await this.runRollup().catch(e => this.logger.error(`[rollup] ${(e as Error).message}`))
  }

  async runRollup(): Promise<{ daily_rows: number; sessions_closed: number }> {
    const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
    const rows = await this.fetchSince(since)

    // Agrega por (data BRT, org, user, module).
    const buckets = new Map<string, DailyBucket>()
    const sessionLastEvent = new Map<string, string>()

    for (const r of rows) {
      const last = sessionLastEvent.get(r.session_id)
      if (!last || r.created_at > last) sessionLastEvent.set(r.session_id, r.created_at)

      const date = this.brtDate(r.created_at)
      const key = `${date}|${r.org_id}|${r.user_id}|${r.module}`
      let b = buckets.get(key)
      if (!b) {
        b = { date, org_id: r.org_id, user_id: r.user_id, module: r.module, visits: 0, total_time_s: 0, events_count: 0, features: new Set(), last_event_at: r.created_at }
        buckets.set(key, b)
      }
      b.events_count++
      if (r.event_name === 'page_view') b.visits++
      if (r.event_name === 'module_exited' && r.duration_ms) b.total_time_s += Math.round(r.duration_ms / 1000)
      if (r.feature) b.features.add(r.feature)
      if (r.created_at > b.last_event_at) b.last_event_at = r.created_at
    }

    const dailyRows = [...buckets.values()].map(b => ({
      date:          b.date,
      org_id:        b.org_id,
      user_id:       b.user_id,
      module:        b.module,
      visits:        b.visits,
      total_time_s:  b.total_time_s,
      events_count:  b.events_count,
      features_used: [...b.features],
      last_event_at: b.last_event_at,
    }))

    for (let i = 0; i < dailyRows.length; i += PAGE) {
      const chunk = dailyRows.slice(i, i + PAGE)
      const { error } = await supabaseAdmin
        .from('telemetry_events_daily')
        .upsert(chunk, { onConflict: 'date,org_id,user_id,module' })
      if (error) this.logger.warn(`[rollup] upsert daily falhou: ${error.message}`)
    }

    const sessionsClosed = await this.closeInactiveSessions(sessionLastEvent)
    this.logger.log(`[rollup] ${dailyRows.length} linhas diárias, ${sessionsClosed} sessões fechadas`)
    return { daily_rows: dailyRows.length, sessions_closed: sessionsClosed }
  }

  /** Fecha sessões com ended_at null cujo último evento foi há >30min. */
  private async closeInactiveSessions(lastEvent: Map<string, string>): Promise<number> {
    const { data: open } = await supabaseAdmin
      .from('telemetry_sessions')
      .select('id, org_id, user_id, started_at')
      .is('ended_at', null)
      .limit(2000)

    const now = Date.now()
    let closed = 0
    for (const s of (open ?? []) as Array<{ id: string; org_id: string; user_id: string; started_at: string }>) {
      const last = lastEvent.get(s.id)
      const reference = last ? new Date(last).getTime() : new Date(s.started_at).getTime()
      if (now - reference < SESSION_IDLE_MS) continue
      const res = await this.sessions.end({ orgId: s.org_id, userId: s.user_id, sessionId: s.id })
      if (res.ended) closed++
    }
    return closed
  }

  /** Lê telemetry_events desde `since` paginando (evita o cap 1000 do PostgREST). */
  private async fetchSince(sinceIso: string): Promise<RawRow[]> {
    const out: RawRow[] = []
    let from = 0
    for (;;) {
      const { data, error } = await supabaseAdmin
        .from('telemetry_events')
        .select('org_id, user_id, session_id, module, event_name, feature, duration_ms, created_at')
        .gte('created_at', sinceIso)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) { this.logger.warn(`[rollup] fetch falhou: ${error.message}`); break }
      const batch = (data ?? []) as RawRow[]
      out.push(...batch)
      if (batch.length < PAGE) break
      from += PAGE
    }
    return out
  }

  /** Data YYYY-MM-DD no fuso de São Paulo (dia de negócio BRT). */
  private brtDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  }
}
