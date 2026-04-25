import { Injectable } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

interface UsageRow {
  provider: string
  model: string
  feature: string
  tokens_input: number
  tokens_output: number
  tokens_total: number
  cost_usd: number
  created_at: string
}

@Injectable()
export class AiUsageService {

  async logUsage(data: Omit<UsageRow, 'created_at'>) {
    const { error } = await supabaseAdmin.from('ai_usage_log').insert(data)
    if (error) console.error('[ai-usage] insert error:', error.message)
  }

  async getSummary() {
    const now = new Date()

    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    const { data: rows } = await supabaseAdmin
      .from('ai_usage_log')
      .select('provider, model, feature, tokens_input, tokens_output, tokens_total, cost_usd, created_at')
      .gte('created_at', firstOfMonth.toISOString())

    const records: UsageRow[] = rows ?? []

    const summary: Record<string, {
      total_tokens: number; total_cost_usd: number
      today_tokens: number; today_cost_usd: number
      by_model: Record<string, { tokens: number; cost: number }>
      by_feature: Record<string, { tokens: number; cost: number }>
    }> = {}

    for (const r of records) {
      if (!summary[r.provider]) {
        summary[r.provider] = { total_tokens: 0, total_cost_usd: 0, today_tokens: 0, today_cost_usd: 0, by_model: {}, by_feature: {} }
      }
      const p = summary[r.provider]
      p.total_tokens   += r.tokens_total
      p.total_cost_usd += Number(r.cost_usd)

      if (new Date(r.created_at) >= startOfToday) {
        p.today_tokens   += r.tokens_total
        p.today_cost_usd += Number(r.cost_usd)
      }

      if (!p.by_model[r.model]) p.by_model[r.model] = { tokens: 0, cost: 0 }
      p.by_model[r.model].tokens += r.tokens_total
      p.by_model[r.model].cost   += Number(r.cost_usd)

      if (r.feature) {
        if (!p.by_feature[r.feature]) p.by_feature[r.feature] = { tokens: 0, cost: 0 }
        p.by_feature[r.feature].tokens += r.tokens_total
        p.by_feature[r.feature].cost   += Number(r.cost_usd)
      }
    }

    // Convert maps to sorted arrays
    const result: Record<string, unknown> = {}
    for (const [prov, data] of Object.entries(summary)) {
      result[prov] = {
        total_tokens:    data.total_tokens,
        total_cost_usd:  Math.round(data.total_cost_usd * 1_000_000) / 1_000_000,
        today_tokens:    data.today_tokens,
        today_cost_usd:  Math.round(data.today_cost_usd * 1_000_000) / 1_000_000,
        by_model: Object.entries(data.by_model)
          .map(([model, v]) => ({ model, ...v, cost: Math.round(v.cost * 1_000_000) / 1_000_000 }))
          .sort((a, b) => b.tokens - a.tokens),
        by_feature: Object.entries(data.by_feature)
          .map(([feature, v]) => ({ feature, ...v, cost: Math.round(v.cost * 1_000_000) / 1_000_000 }))
          .sort((a, b) => b.tokens - a.tokens),
      }
    }
    return result
  }

  async getLast30Days() {
    const from = new Date(Date.now() - 30 * 86400 * 1000).toISOString()

    const { data: rows } = await supabaseAdmin
      .from('ai_usage_log')
      .select('provider, cost_usd, created_at')
      .gte('created_at', from)

    const byDay: Record<string, { anthropic_cost: number; openai_cost: number }> = {}

    for (const r of rows ?? []) {
      const day = r.created_at.split('T')[0]
      if (!byDay[day]) byDay[day] = { anthropic_cost: 0, openai_cost: 0 }
      if (r.provider === 'anthropic') byDay[day].anthropic_cost += Number(r.cost_usd)
      if (r.provider === 'openai')    byDay[day].openai_cost    += Number(r.cost_usd)
    }

    return Object.entries(byDay)
      .map(([date, v]) => ({
        date,
        anthropic_cost: Math.round(v.anthropic_cost * 1_000_000) / 1_000_000,
        openai_cost:    Math.round(v.openai_cost    * 1_000_000) / 1_000_000,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }
}
