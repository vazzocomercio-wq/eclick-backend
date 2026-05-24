import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'

const PAGE = 1000

interface DailyRow {
  date:          string
  org_id:        string
  user_id:       string
  module:        string
  visits:        number
  total_time_s:  number
  events_count:  number
}

/**
 * Camada de leitura do dashboard /insights (visão de founder, cross-org).
 * Agrega em JS (mesmo padrão do storefront-analytics) a partir de
 * telemetry_events_daily + telemetry_sessions. Tudo gated por PlatformAdminGuard.
 */
@Injectable()
export class InsightsService {
  private readonly logger = new Logger(InsightsService.name)

  /** Visão geral: ativos, sessões, tempo médio, eventos — com delta vs período anterior. */
  async overview(fromDate: string, toDate: string) {
    const lenDays = this.daysBetween(fromDate, toDate)
    const prevTo = this.dateMinus(fromDate, 1)
    const prevFrom = this.dateMinus(fromDate, lenDays)

    const [curr, prev] = await Promise.all([
      this.periodStats(fromDate, toDate),
      this.periodStats(prevFrom, prevTo),
    ])

    return {
      period: { from: fromDate, to: toDate },
      active_users:  { value: curr.activeUsers, delta: curr.activeUsers - prev.activeUsers },
      sessions:      { value: curr.sessions, delta: curr.sessions - prev.sessions },
      avg_session_minutes: curr.avgSessionMinutes,
      total_events:  { value: curr.totalEvents, delta: curr.totalEvents - prev.totalEvents },
    }
  }

  /** Ranking de módulos por usuários únicos no período. */
  async modulesRanking(periodDays: number) {
    const to = this.today()
    const from = this.dateMinus(to, periodDays - 1)
    const daily = await this.fetchDailyRange(from, to)

    const totalUsers = new Set(daily.map(r => r.user_id)).size || 1
    const byModule = new Map<string, { users: Set<string>; events: number; time_s: number }>()
    for (const r of daily) {
      let m = byModule.get(r.module)
      if (!m) { m = { users: new Set(), events: 0, time_s: 0 }; byModule.set(r.module, m) }
      m.users.add(r.user_id)
      m.events += r.events_count
      m.time_s += r.total_time_s
    }

    return {
      period_days: periodDays,
      total_active_users: totalUsers,
      modules: [...byModule.entries()]
        .map(([module, m]) => ({
          module,
          users: m.users.size,
          usage_pct: Math.round((m.users.size / totalUsers) * 100),
          events: m.events,
          time_minutes: Math.round(m.time_s / 60),
        }))
        .sort((a, b) => b.users - a.users || b.events - a.events),
    }
  }

  /** Matriz usuário × módulo (heatmap). Resolve email do usuário. */
  async usageMatrix(periodDays: number) {
    const to = this.today()
    const from = this.dateMinus(to, periodDays - 1)
    const daily = await this.fetchDailyRange(from, to)
    const emails = await this.emailMap()

    const byUser = new Map<string, { org_id: string; modules: Record<string, number>; total: number }>()
    for (const r of daily) {
      let u = byUser.get(r.user_id)
      if (!u) { u = { org_id: r.org_id, modules: {}, total: 0 }; byUser.set(r.user_id, u) }
      u.modules[r.module] = (u.modules[r.module] ?? 0) + r.events_count
      u.total += r.events_count
    }

    return {
      period_days: periodDays,
      users: [...byUser.entries()]
        .map(([user_id, u]) => ({
          user_id,
          email: emails.get(user_id) ?? null,
          org_id: u.org_id,
          modules: u.modules,
          total_events: u.total,
        }))
        .sort((a, b) => b.total_events - a.total_events),
    }
  }

  // ---- internos ----

  private async periodStats(from: string, to: string) {
    const [daily, sessions] = await Promise.all([
      this.fetchDailyRange(from, to),
      this.fetchSessionsRange(from, to),
    ])
    const activeUsers = new Set(daily.map(r => r.user_id)).size
    const totalEvents = daily.reduce((s, r) => s + r.events_count, 0)
    const ended = sessions.filter(s => typeof s.duration_s === 'number')
    const avgSessionMinutes = ended.length
      ? Math.round((ended.reduce((s, x) => s + (x.duration_s ?? 0), 0) / ended.length / 60) * 10) / 10
      : 0
    return { activeUsers, totalEvents, sessions: sessions.length, avgSessionMinutes }
  }

  private async fetchDailyRange(from: string, to: string): Promise<DailyRow[]> {
    const out: DailyRow[] = []
    let offset = 0
    for (;;) {
      const { data, error } = await supabaseAdmin
        .from('telemetry_events_daily')
        .select('date, org_id, user_id, module, visits, total_time_s, events_count')
        .gte('date', from).lte('date', to)
        .order('date', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (error) { this.logger.warn(`[insights] daily fetch: ${error.message}`); break }
      const batch = (data ?? []) as DailyRow[]
      out.push(...batch)
      if (batch.length < PAGE) break
      offset += PAGE
    }
    return out
  }

  private async fetchSessionsRange(from: string, to: string): Promise<Array<{ duration_s: number | null }>> {
    const out: Array<{ duration_s: number | null }> = []
    let offset = 0
    const fromIso = `${from}T00:00:00-03:00`
    const toIso = `${to}T23:59:59-03:00`
    for (;;) {
      const { data, error } = await supabaseAdmin
        .from('telemetry_sessions')
        .select('duration_s')
        .gte('started_at', fromIso).lte('started_at', toIso)
        .order('started_at', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (error) { this.logger.warn(`[insights] sessions fetch: ${error.message}`); break }
      const batch = (data ?? []) as Array<{ duration_s: number | null }>
      out.push(...batch)
      if (batch.length < PAGE) break
      offset += PAGE
    }
    return out
  }

  /** id → email de todos os usuários (escala founder ~dezenas). */
  private async emailMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    try {
      const { data } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 })
      for (const u of data?.users ?? []) if (u.email) map.set(u.id, u.email)
    } catch (e) {
      this.logger.warn(`[insights] listUsers falhou: ${(e as Error).message}`)
    }
    return map
  }

  private today(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  }

  private dateMinus(date: string, days: number): string {
    const d = new Date(`${date}T12:00:00-03:00`)
    d.setUTCDate(d.getUTCDate() - days)
    return d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  }

  private daysBetween(from: string, to: string): number {
    const a = new Date(`${from}T12:00:00-03:00`).getTime()
    const b = new Date(`${to}T12:00:00-03:00`).getTime()
    return Math.max(1, Math.round((b - a) / 86400000) + 1)
  }
}
