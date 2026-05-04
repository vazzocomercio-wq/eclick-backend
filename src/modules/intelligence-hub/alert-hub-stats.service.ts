import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

export interface OrgStats {
  window_days:        number
  signals_total:      number
  by_severity:        Record<'critical' | 'warning' | 'info', number>
  by_analyzer:        Record<string, number>
  by_status:          Record<string, number>
  top_categories:     Array<{ category: string; count: number }>
  deliveries_total:   number
  deliveries_sent:    number
  deliveries_failed:  number
  responded_total:    number
  action_rate:        number  // approved / responded
  avg_response_min:   number | null
}

export interface ManagerStat {
  manager_id:        string
  name:              string
  department:        string
  signals_received:  number
  sent:              number
  failed:            number
  responded:         number
  approved:          number
  ignored:           number
  details:           number
  custom:            number
  action_rate:       number  // approved / responded
  avg_response_min:  number | null
  top_categories:    Array<{ category: string; count: number }>
}

interface SignalRow {
  severity: string; analyzer: string; status: string; category: string
}
interface DeliveryRow {
  status: string; response_type: string | null; sent_at: string | null; response_at: string | null
}
interface ManagerDeliveryRow {
  manager_id: string; status: string; response_type: string | null
  sent_at: string | null; response_at: string | null
  alert_signals: { category: string } | { category: string }[] | null
}

@Injectable()
export class AlertHubStatsService {
  private readonly logger = new Logger(AlertHubStatsService.name)

  async getOrgStats(orgId: string, days = 30): Promise<OrgStats> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString()

    const [signalsRes, deliveriesRes] = await Promise.all([
      supabaseAdmin
        .from('alert_signals')
        .select('severity, analyzer, status, category')
        .eq('organization_id', orgId)
        .gte('created_at', since),
      supabaseAdmin
        .from('alert_deliveries')
        .select('status, response_type, sent_at, response_at')
        .eq('organization_id', orgId)
        .gte('created_at', since),
    ])

    if (signalsRes.error) throw new BadRequestException(signalsRes.error.message)
    if (deliveriesRes.error) throw new BadRequestException(deliveriesRes.error.message)

    const signals    = (signalsRes.data ?? []) as SignalRow[]
    const deliveries = (deliveriesRes.data ?? []) as DeliveryRow[]

    const by_severity: OrgStats['by_severity'] = { critical: 0, warning: 0, info: 0 }
    const by_analyzer: Record<string, number>   = {}
    const by_status:   Record<string, number>   = {}
    const cats:        Record<string, number>   = {}

    for (const s of signals) {
      const sev = s.severity as keyof OrgStats['by_severity']
      by_severity[sev] = (by_severity[sev] ?? 0) + 1
      by_analyzer[s.analyzer] = (by_analyzer[s.analyzer] ?? 0) + 1
      by_status[s.status]     = (by_status[s.status] ?? 0) + 1
      cats[s.category]        = (cats[s.category] ?? 0) + 1
    }

    const top_categories = Object.entries(cats)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([category, count]) => ({ category, count }))

    let sent = 0, failed = 0, responded = 0, approved = 0
    let totalResponseMin = 0, responseCount = 0
    for (const d of deliveries) {
      if (['sent', 'delivered', 'read'].includes(d.status)) sent++
      if (d.status === 'failed') failed++
      if (d.response_type) {
        responded++
        if (d.response_type === 'approve') approved++
        if (d.sent_at && d.response_at) {
          const mins = (new Date(d.response_at).getTime() - new Date(d.sent_at).getTime()) / 60_000
          if (mins >= 0 && mins < 10_000) {
            totalResponseMin += mins
            responseCount++
          }
        }
      }
    }

    return {
      window_days:       days,
      signals_total:     signals.length,
      by_severity,
      by_analyzer,
      by_status,
      top_categories,
      deliveries_total:  deliveries.length,
      deliveries_sent:   sent,
      deliveries_failed: failed,
      responded_total:   responded,
      action_rate:       responded > 0 ? approved / responded : 0,
      avg_response_min:  responseCount > 0 ? totalResponseMin / responseCount : null,
    }
  }

  async getManagerStats(orgId: string, days = 30): Promise<ManagerStat[]> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString()

    // Carrega managers da org
    const { data: managers, error: mErr } = await supabaseAdmin
      .from('alert_managers')
      .select('id, name, department')
      .eq('organization_id', orgId)
    if (mErr) throw new BadRequestException(mErr.message)

    if ((managers ?? []).length === 0) return []

    // Carrega deliveries da org com join no signal pra category
    const { data: rows, error: dErr } = await supabaseAdmin
      .from('alert_deliveries')
      .select(`
        manager_id, status, response_type, sent_at, response_at,
        alert_signals!inner ( category )
      `)
      .eq('organization_id', orgId)
      .gte('created_at', since)
    if (dErr) throw new BadRequestException(dErr.message)

    const list = (rows ?? []) as unknown as ManagerDeliveryRow[]

    // Agrega por manager
    const acc = new Map<string, {
      received: number; sent: number; failed: number; responded: number
      approved: number; ignored: number; details: number; custom: number
      respMins: number[]
      cats: Record<string, number>
    }>()

    for (const r of list) {
      const cur = acc.get(r.manager_id) ?? {
        received: 0, sent: 0, failed: 0, responded: 0,
        approved: 0, ignored: 0, details: 0, custom: 0,
        respMins: [], cats: {},
      }
      cur.received++
      if (['sent', 'delivered', 'read'].includes(r.status)) cur.sent++
      if (r.status === 'failed') cur.failed++
      if (r.response_type) {
        cur.responded++
        if (r.response_type === 'approve') cur.approved++
        if (r.response_type === 'ignore')  cur.ignored++
        if (r.response_type === 'details') cur.details++
        if (r.response_type === 'custom')  cur.custom++
        if (r.sent_at && r.response_at) {
          const mins = (new Date(r.response_at).getTime() - new Date(r.sent_at).getTime()) / 60_000
          if (mins >= 0 && mins < 10_000) cur.respMins.push(mins)
        }
      }
      const sig = r.alert_signals
      const cat = Array.isArray(sig) ? sig[0]?.category : sig?.category
      if (cat) cur.cats[cat] = (cur.cats[cat] ?? 0) + 1
      acc.set(r.manager_id, cur)
    }

    return (managers ?? []).map(m => {
      const a = acc.get(m.id)
      const top = a ? Object.entries(a.cats)
        .sort((x, y) => y[1] - x[1]).slice(0, 5)
        .map(([category, count]) => ({ category, count })) : []
      const avgResp = a && a.respMins.length > 0
        ? a.respMins.reduce((s, x) => s + x, 0) / a.respMins.length
        : null
      return {
        manager_id:       m.id,
        name:             m.name,
        department:       m.department,
        signals_received: a?.received ?? 0,
        sent:             a?.sent     ?? 0,
        failed:           a?.failed   ?? 0,
        responded:        a?.responded ?? 0,
        approved:         a?.approved  ?? 0,
        ignored:          a?.ignored   ?? 0,
        details:          a?.details   ?? 0,
        custom:           a?.custom    ?? 0,
        action_rate:      (a?.responded ?? 0) > 0 ? (a!.approved / a!.responded) : 0,
        avg_response_min: avgResp,
        top_categories:   top,
      }
    })
  }
}
