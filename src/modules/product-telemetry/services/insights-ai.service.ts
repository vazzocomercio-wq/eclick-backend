import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { LlmService } from '../../ai/llm.service'
import { WhatsAppSender } from '../../whatsapp/whatsapp.sender'

const PAGE = 1000
const MIN_WEEK_EVENTS = 20
const ALERT_PHONE = process.env.TELEMETRY_ALERT_PHONE ?? ''
const VALID_TYPES = new Set(['usage_drop', 'churn_risk', 'task_abandon', 'healthy_pattern'])
const VALID_SEVERITY = new Set(['low', 'medium', 'high'])

interface DailyRow { date: string; org_id: string; user_id: string; module: string; events_count: number; total_time_s: number }
interface EngRow { user_id: string; status: string; trend: string; last_seen_at: string | null; score: number }
interface LlmInsight {
  type: string; severity: string; title: string; body: string
  evidence?: unknown; recommendation?: string
}

/**
 * Gera insights de produto por IA a partir dos agregados de uso.
 * Roda 1×/dia às 6h BRT (9h UTC). Para cada org com uso relevante na semana,
 * monta um payload (uso por módulo semana vs anterior, engajamento, funis de
 * tarefa), pede ao LLM (sonnet, jsonMode) insights estruturados e grava em
 * telemetry_ai_insights. severity=high dispara alerta WhatsApp ao founder.
 */
@Injectable()
export class InsightsAiService {
  private readonly logger = new Logger(InsightsAiService.name)

  constructor(
    private readonly llm: LlmService,
    private readonly wa:  WhatsAppSender,
  ) {}

  @Cron('0 9 * * *', { name: 'telemetry-ai-insights' })
  async scheduled() {
    await this.generateAll().catch(e => this.logger.error(`[ai-insights] ${(e as Error).message}`))
  }

  async generateAll(): Promise<{ orgs: number; insights: number; alerts: number }> {
    const today = this.brtToday()
    const thisFrom = this.brtMinus(6)
    const weekDaily = await this.fetchDaily({ from: thisFrom, to: today })

    const eventsByOrg = new Map<string, number>()
    for (const r of weekDaily) eventsByOrg.set(r.org_id, (eventsByOrg.get(r.org_id) ?? 0) + r.events_count)
    const orgs = [...eventsByOrg.entries()].filter(([, n]) => n >= MIN_WEEK_EVENTS).map(([id]) => id)

    const emails = await this.emailMap()
    let insightsTotal = 0
    let alerts = 0
    for (const orgId of orgs) {
      const created = await this.generateForOrg(orgId, emails)
      insightsTotal += created.length
      const high = created.filter(c => c.severity === 'high')
      if (high.length && ALERT_PHONE) {
        const sent = await this.sendAlert(orgId, high)
        if (sent) alerts++
      }
    }
    this.logger.log(`[ai-insights] ${orgs.length} orgs, ${insightsTotal} insights, ${alerts} alertas`)
    return { orgs: orgs.length, insights: insightsTotal, alerts }
  }

  async generateForOrg(orgId: string, emails?: Map<string, string>): Promise<Array<{ severity: string; title: string }>> {
    const today = this.brtToday()
    const thisFrom = this.brtMinus(6)
    const prevFrom = this.brtMinus(13)
    const prevTo = this.brtMinus(7)
    const emailMap = emails ?? await this.emailMap()

    const payload = await this.buildPayload(orgId, { thisFrom, today, prevFrom, prevTo }, emailMap)
    if (payload.total_events_week < MIN_WEEK_EVENTS) return []

    let parsed: { insights?: LlmInsight[] }
    try {
      const out = await this.llm.generateText({
        orgId,
        feature:      'telemetry_insights',
        systemPrompt: SYSTEM_PROMPT,
        userPrompt:   this.buildUserPrompt(payload),
        jsonMode:     true,
        maxTokens:    1800,
        temperature:  0.4,
      })
      parsed = this.safeParse(out.text)
    } catch (e) {
      this.logger.warn(`[ai-insights] org=${orgId} LLM falhou: ${(e as Error).message}`)
      return []
    }

    const insights = (parsed.insights ?? [])
      .filter(i => i && VALID_TYPES.has(i.type) && VALID_SEVERITY.has(i.severity) && typeof i.title === 'string' && typeof i.body === 'string')
      .slice(0, 8)
    if (!insights.length) return []

    // Dedup: substitui os insights não-resolvidos do mesmo período (snapshot diário).
    await supabaseAdmin.from('telemetry_ai_insights')
      .delete()
      .eq('org_id', orgId).eq('period_start', thisFrom).eq('period_end', today).eq('resolved', false)

    const rows = insights.map(i => ({
      org_id:         orgId,
      period_start:   thisFrom,
      period_end:     today,
      type:           i.type,
      severity:       i.severity,
      title:          i.title.slice(0, 300),
      body:           i.body.slice(0, 4000),
      evidence:       (i.evidence && typeof i.evidence === 'object') ? i.evidence : null,
      recommendation: typeof i.recommendation === 'string' ? i.recommendation.slice(0, 1000) : null,
    }))
    const { error } = await supabaseAdmin.from('telemetry_ai_insights').insert(rows)
    if (error) { this.logger.warn(`[ai-insights] insert org=${orgId}: ${error.message}`); return [] }

    return insights.map(i => ({ severity: i.severity, title: i.title }))
  }

  // ---- payload ----

  private async buildPayload(
    orgId: string,
    w: { thisFrom: string; today: string; prevFrom: string; prevTo: string },
    emails: Map<string, string>,
  ) {
    const orgName = await this.fetchOrgName(orgId)
    const daily = await this.fetchDaily({ from: w.prevFrom, to: w.today, orgId })

    const thisWeek = daily.filter(r => r.date >= w.thisFrom && r.date <= w.today)
    const prevWeek = daily.filter(r => r.date >= w.prevFrom && r.date <= w.prevTo)

    const modAgg = (rows: DailyRow[]) => {
      const m = new Map<string, { events: number; users: Set<string> }>()
      for (const r of rows) {
        let x = m.get(r.module)
        if (!x) { x = { events: 0, users: new Set() }; m.set(r.module, x) }
        x.events += r.events_count
        x.users.add(r.user_id)
      }
      return m
    }
    const thisMod = modAgg(thisWeek)
    const prevMod = modAgg(prevWeek)
    const modules = [...new Set([...thisMod.keys(), ...prevMod.keys()])].map(module => {
      const t = thisMod.get(module)?.events ?? 0
      const p = prevMod.get(module)?.events ?? 0
      const delta_pct = p === 0 ? (t > 0 ? 100 : 0) : Math.round(((t - p) / p) * 100)
      return { module, events_this_week: t, events_prev_week: p, delta_pct, users_this_week: thisMod.get(module)?.users.size ?? 0 }
    }).sort((a, b) => b.events_this_week - a.events_this_week)

    // Engajamento da org.
    const eng = await this.fetchEngagement(orgId)
    const statusCounts: Record<string, number> = {}
    for (const e of eng) statusCounts[e.status] = (statusCounts[e.status] ?? 0) + 1
    const atRisk = eng
      .filter(e => e.status === 'at_risk' || e.status === 'inactive' || e.trend === 'down')
      .map(e => ({
        email: emails.get(e.user_id) ?? e.user_id.slice(0, 8),
        status: e.status,
        trend: e.trend,
        days_since_last_seen: e.last_seen_at ? Math.floor((Date.now() - new Date(e.last_seen_at).getTime()) / 86400000) : null,
      }))
      .slice(0, 20)

    // Funis de tarefa (a partir dos eventos task.*).
    const taskFunnels = await this.fetchTaskFunnels(orgId, w.thisFrom)

    return {
      org_name: orgName,
      period: { from: w.thisFrom, to: w.today },
      total_events_week: thisWeek.reduce((s, r) => s + r.events_count, 0),
      active_users_week: new Set(thisWeek.map(r => r.user_id)).size,
      module_usage: modules,
      engagement: { by_status: statusCounts, at_risk_or_declining: atRisk },
      task_funnels: taskFunnels,
    }
  }

  private buildUserPrompt(payload: unknown): string {
    return [
      'Analise os dados de uso do produto e-Click (SaaS de gestão de e-commerce) na última semana vs a anterior.',
      'Identifique: (1) módulos com queda significativa de uso (>30% vs semana anterior),',
      '(2) usuários em risco de churn (sumiram há vários dias ou trend de queda),',
      '(3) tarefas com alta taxa de abandono (>40%), (4) padrões de uso saudáveis pra destacar.',
      '',
      'Responda SOMENTE com JSON no formato:',
      '{"insights":[{"type":"usage_drop|churn_risk|task_abandon|healthy_pattern","severity":"low|medium|high","title":"curto","body":"1-2 parágrafos em PT-BR","evidence":{"numeros":"concretos"},"recommendation":"ação sugerida em PT-BR"}]}',
      'Máximo 8 insights, priorize os mais acionáveis. Use números concretos do payload no evidence.',
      '',
      'Dados:',
      JSON.stringify(payload),
    ].join('\n')
  }

  private async sendAlert(orgId: string, high: Array<{ title: string }>): Promise<boolean> {
    const lines = high.map(h => `🔴 ${h.title}`).join('\n')
    const msg = `e-Click Insights — alerta(s) de alta severidade (org ${orgId.slice(0, 8)}):\n\n${lines}\n\nVeja em /insights.`
    try {
      const r = await this.wa.sendTextMessage({ phone: ALERT_PHONE, message: msg })
      if (!r.success) this.logger.warn(`[ai-insights] alerta WhatsApp falhou: ${r.error}`)
      return r.success
    } catch (e) {
      this.logger.warn(`[ai-insights] alerta WhatsApp erro: ${(e as Error).message}`)
      return false
    }
  }

  // ---- fetchers ----

  private async fetchDaily(opts: { from: string; to: string; orgId?: string }): Promise<DailyRow[]> {
    const out: DailyRow[] = []
    let offset = 0
    for (;;) {
      let q = supabaseAdmin
        .from('telemetry_events_daily')
        .select('date, org_id, user_id, module, events_count, total_time_s')
        .gte('date', opts.from).lte('date', opts.to)
        .order('date', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (opts.orgId) q = q.eq('org_id', opts.orgId)
      const { data, error } = await q
      if (error) { this.logger.warn(`[ai-insights] daily: ${error.message}`); break }
      const batch = (data ?? []) as DailyRow[]
      out.push(...batch)
      if (batch.length < PAGE) break
      offset += PAGE
    }
    return out
  }

  private async fetchEngagement(orgId: string): Promise<EngRow[]> {
    const { data } = await supabaseAdmin
      .from('telemetry_user_engagement')
      .select('user_id, status, trend, last_seen_at, score')
      .eq('org_id', orgId)
      .limit(2000)
    return (data ?? []) as EngRow[]
  }

  private async fetchTaskFunnels(orgId: string, fromDate: string) {
    const fromIso = `${fromDate}T00:00:00-03:00`
    const { data } = await supabaseAdmin
      .from('telemetry_events')
      .select('event_name, properties')
      .eq('org_id', orgId)
      .in('event_name', ['task.started', 'task.completed', 'task.abandoned'])
      .gte('created_at', fromIso)
      .limit(5000)
    const agg = new Map<string, { started: number; completed: number; abandoned: number }>()
    for (const r of (data ?? []) as Array<{ event_name: string; properties: { task_name?: string } }>) {
      const task = r.properties?.task_name ?? 'desconhecida'
      let x = agg.get(task)
      if (!x) { x = { started: 0, completed: 0, abandoned: 0 }; agg.set(task, x) }
      if (r.event_name === 'task.started') x.started++
      else if (r.event_name === 'task.completed') x.completed++
      else if (r.event_name === 'task.abandoned') x.abandoned++
    }
    return [...agg.entries()].map(([task, x]) => ({
      task,
      ...x,
      completion_rate: x.started ? Math.round((x.completed / x.started) * 100) : 0,
      abandon_rate:    x.started ? Math.round((x.abandoned / x.started) * 100) : 0,
    }))
  }

  private async fetchOrgName(orgId: string): Promise<string> {
    const { data } = await supabaseAdmin.from('organizations').select('name').eq('id', orgId).maybeSingle()
    return (data as { name?: string } | null)?.name ?? orgId.slice(0, 8)
  }

  private async emailMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    try {
      const { data } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 })
      for (const u of data?.users ?? []) if (u.email) map.set(u.id, u.email)
    } catch (e) {
      this.logger.warn(`[ai-insights] listUsers: ${(e as Error).message}`)
    }
    return map
  }

  private safeParse(text: string): { insights?: LlmInsight[] } {
    const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    try { return JSON.parse(cleaned) } catch { return {} }
  }

  private brtToday(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  }

  private brtMinus(days: number): string {
    return new Date(Date.now() - days * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  }
}

const SYSTEM_PROMPT =
  'Você é um analista de produto sênior do e-Click (SaaS de gestão de e-commerce/marketplace). ' +
  'Recebe agregados de uso e devolve insights acionáveis pro founder priorizar features. ' +
  'Seja específico, use os números do payload, escreva em PT-BR claro e direto. Responda SOMENTE JSON válido.'
