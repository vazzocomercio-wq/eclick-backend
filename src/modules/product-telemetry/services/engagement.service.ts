import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'

const PAGE = 1000

interface DailyRow {
  date:          string
  org_id:        string
  user_id:       string
  module:        string
  total_time_s:  number
  events_count:  number
  last_event_at: string | null
}

type Status = 'power_user' | 'engaged' | 'casual' | 'at_risk' | 'inactive'
type Trend  = 'up' | 'stable' | 'down'

/**
 * Calcula o health score 0-100 por usuário (base do alerta de churn).
 * Roda de hora em hora. Lê telemetry_events_daily dos últimos 30d e mede a
 * semana corrente (7d) contra a anterior pra derivar a tendência.
 */
@Injectable()
export class EngagementService {
  private readonly logger = new Logger(EngagementService.name)

  @Cron('0 * * * *', { name: 'telemetry-engagement' })
  async scheduled() {
    await this.runEngagement().catch(e => this.logger.error(`[engagement] ${(e as Error).message}`))
  }

  async runEngagement(): Promise<{ users: number }> {
    const today = this.brtDate(Date.now())
    const thisWeekStart = this.brtDateMinus(6)   // hoje-6 → 7 dias
    const prevWeekStart = this.brtDateMinus(13)
    const prevWeekEnd   = this.brtDateMinus(7)
    const since30 = this.brtDateMinus(29)

    const rows = await this.fetchDailySince(since30)

    // Agrupa por usuário.
    const byUser = new Map<string, DailyRow[]>()
    for (const r of rows) {
      const k = `${r.org_id}|${r.user_id}`
      const arr = byUser.get(k)
      if (arr) arr.push(r)
      else byUser.set(k, [r])
    }

    const upserts: Array<Record<string, unknown>> = []
    for (const [, userRows] of byUser) {
      const { org_id, user_id } = userRows[0]
      const thisWeek = userRows.filter(r => r.date >= thisWeekStart && r.date <= today)
      const prevWeek = userRows.filter(r => r.date >= prevWeekStart && r.date <= prevWeekEnd)

      const score = this.scoreOf(thisWeek)
      const prevScore = this.scoreOf(prevWeek)
      const lastSeen = userRows
        .map(r => r.last_event_at)
        .filter((d): d is string => !!d)
        .sort()
        .pop() ?? null

      upserts.push({
        org_id,
        user_id,
        score,
        status:              this.statusOf(score),
        weekly_active_days:  new Set(thisWeek.map(r => r.date)).size,
        weekly_module_count: new Set(thisWeek.map(r => r.module)).size,
        weekly_time_minutes: Math.round(thisWeek.reduce((s, r) => s + (r.total_time_s ?? 0), 0) / 60),
        trend:               this.trendOf(score, prevScore),
        last_seen_at:        lastSeen,
        updated_at:          new Date().toISOString(),
      })
    }

    for (let i = 0; i < upserts.length; i += PAGE) {
      const chunk = upserts.slice(i, i + PAGE)
      const { error } = await supabaseAdmin
        .from('telemetry_user_engagement')
        .upsert(chunk, { onConflict: 'org_id,user_id' })
      if (error) this.logger.warn(`[engagement] upsert falhou: ${error.message}`)
    }

    this.logger.log(`[engagement] ${upserts.length} usuários atualizados`)
    return { users: upserts.length }
  }

  private scoreOf(weekRows: DailyRow[]): number {
    const activeDays  = new Set(weekRows.map(r => r.date)).size
    const moduleCount = new Set(weekRows.map(r => r.module)).size
    const timeMinutes = weekRows.reduce((s, r) => s + (r.total_time_s ?? 0), 0) / 60
    const raw = activeDays * 8 + moduleCount * 4 + Math.min(timeMinutes / 5, 20)
    return Math.max(0, Math.min(100, Math.round(raw)))
  }

  private statusOf(score: number): Status {
    if (score >= 80) return 'power_user'
    if (score >= 50) return 'engaged'
    if (score >= 20) return 'casual'
    if (score >= 1)  return 'at_risk'
    return 'inactive'
  }

  private trendOf(score: number, prev: number): Trend {
    if (prev === 0) return score > 0 ? 'up' : 'stable'
    if (score > prev * 1.1) return 'up'
    if (score < prev * 0.9) return 'down'
    return 'stable'
  }

  private async fetchDailySince(sinceDate: string): Promise<DailyRow[]> {
    const out: DailyRow[] = []
    let from = 0
    for (;;) {
      const { data, error } = await supabaseAdmin
        .from('telemetry_events_daily')
        .select('date, org_id, user_id, module, total_time_s, events_count, last_event_at')
        .gte('date', sinceDate)
        .order('date', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) { this.logger.warn(`[engagement] fetch falhou: ${error.message}`); break }
      const batch = (data ?? []) as DailyRow[]
      out.push(...batch)
      if (batch.length < PAGE) break
      from += PAGE
    }
    return out
  }

  private brtDate(ms: number): string {
    return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  }

  private brtDateMinus(days: number): string {
    return this.brtDate(Date.now() - days * 86400 * 1000)
  }
}
