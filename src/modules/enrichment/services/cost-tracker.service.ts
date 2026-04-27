import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'

export interface ProviderRow {
  id?: string
  organization_id: string
  provider_code: string
  display_name: string
  is_enabled: boolean
  api_key: string | null
  api_secret: string | null
  base_url: string | null
  cost_per_query_cents: number
  monthly_budget_brl: number | null
  monthly_spent_brl: number
}

@Injectable()
export class EnrichmentCostTrackerService {
  private readonly logger = new Logger(EnrichmentCostTrackerService.name)

  /** True if the provider is enabled AND under budget for the month. */
  async hasBudget(orgId: string, code: string): Promise<boolean> {
    try {
      const { data } = await supabaseAdmin
        .from('enrichment_providers')
        .select('is_enabled, monthly_budget_brl, monthly_spent_brl')
        .eq('organization_id', orgId)
        .eq('provider_code', code)
        .maybeSingle()
      if (!data) return false
      if (!data.is_enabled) return false
      const budget = data.monthly_budget_brl as number | null
      const spent  = Number(data.monthly_spent_brl ?? 0)
      if (budget == null) return true // no cap configured
      return spent < Number(budget)
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[enrichment.cost.hasBudget] ${err?.message}`)
      return false
    }
  }

  /** Increment monthly_spent_brl by the cost (in cents) of one call. */
  async track(orgId: string, code: string, costCents: number): Promise<void> {
    if (costCents <= 0) return
    try {
      const { data } = await supabaseAdmin
        .from('enrichment_providers')
        .select('id, monthly_spent_brl')
        .eq('organization_id', orgId)
        .eq('provider_code', code)
        .maybeSingle()
      if (!data) return
      const cur = Number(data.monthly_spent_brl ?? 0)
      const next = cur + costCents / 100
      await supabaseAdmin
        .from('enrichment_providers')
        .update({ monthly_spent_brl: next, updated_at: new Date().toISOString() })
        .eq('id', data.id as string)
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[enrichment.cost.track] ${err?.message}`)
    }
  }

  /** Provider credentials + budget snapshot fetched in one call so the
   * orchestrator can decide enable/budget/cost in O(1). */
  async getProvider(orgId: string, code: string): Promise<ProviderRow | null> {
    try {
      const { data } = await supabaseAdmin
        .from('enrichment_providers')
        .select('*')
        .eq('organization_id', orgId)
        .eq('provider_code', code)
        .maybeSingle()
      return (data as ProviderRow) ?? null
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[enrichment.cost.getProvider] ${err?.message}`)
      return null
    }
  }

  async listProviders(orgId: string): Promise<ProviderRow[]> {
    const { data } = await supabaseAdmin
      .from('enrichment_providers').select('*').eq('organization_id', orgId)
    return (data ?? []) as ProviderRow[]
  }

  async upsertProvider(row: Partial<ProviderRow> & { organization_id: string; provider_code: string; display_name?: string }): Promise<ProviderRow> {
    const { data, error } = await supabaseAdmin
      .from('enrichment_providers')
      .upsert(
        { display_name: row.display_name ?? row.provider_code, ...row, updated_at: new Date().toISOString() },
        { onConflict: 'organization_id,provider_code' },
      )
      .select().single()
    if (error) throw new Error(error.message)
    return data as ProviderRow
  }

  /** Reset all org provider monthly_spent_brl on the 1st at 00:05 UTC. */
  @Cron('5 0 1 * *')
  async monthlyReset() {
    try {
      const { error } = await supabaseAdmin
        .from('enrichment_providers')
        .update({ monthly_spent_brl: 0, updated_at: new Date().toISOString() })
        .gt('monthly_spent_brl', 0)
      if (error) this.logger.warn(`[enrichment.cost.reset] ${error.message}`)
      else this.logger.log('[enrichment.cost.reset] monthly counters zeroed')
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[enrichment.cost.reset] ${err?.message}`)
    }
  }
}
