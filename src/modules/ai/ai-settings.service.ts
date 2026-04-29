import { Injectable, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { FEATURE_REGISTRY, FEATURE_KEYS, FeatureKey, Provider } from './defaults'
import { FeatureSettingRow, MergedFeatureSetting } from './types'

export interface UpsertFeatureSettingDto {
  primary_provider:   Provider
  primary_model:      string
  fallback_provider?: Provider | null
  fallback_model?:    string | null
  enabled?:           boolean
}

@Injectable()
export class AiSettingsService {
  /** GET /ai/settings — para cada feature do registry, devolve a config
   * efetiva (override da org se houver, senão default). isDefault sinaliza
   * pra UI exibir o badge "Padrão do sistema". */
  async listForOrg(orgId: string): Promise<MergedFeatureSetting[]> {
    const { data, error } = await supabaseAdmin
      .from('ai_feature_settings')
      .select('*')
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)

    const overrides = new Map<FeatureKey, FeatureSettingRow>()
    for (const r of (data ?? []) as FeatureSettingRow[]) {
      overrides.set(r.feature_key, r)
    }

    return FEATURE_KEYS.map(key => {
      const reg = FEATURE_REGISTRY[key]
      const override = overrides.get(key)
      if (override) {
        return {
          feature_key:       key,
          label:             reg.label,
          description:       reg.description,
          primary_provider:  override.primary_provider,
          primary_model:     override.primary_model,
          fallback_provider: override.fallback_provider,
          fallback_model:    override.fallback_model,
          enabled:           override.enabled,
          isDefault:         false,
        }
      }
      return {
        feature_key:       key,
        label:             reg.label,
        description:       reg.description,
        primary_provider:  reg.primary.provider as Provider,
        primary_model:     reg.primary.model,
        fallback_provider: reg.fallback ? (reg.fallback.provider as Provider) : null,
        fallback_model:    reg.fallback ? reg.fallback.model : null,
        enabled:           true,
        isDefault:         true,
      }
    })
  }

  /** PUT /ai/settings/:featureKey — upsert. */
  async upsert(orgId: string, featureKey: string, dto: UpsertFeatureSettingDto): Promise<MergedFeatureSetting> {
    if (!FEATURE_KEYS.includes(featureKey as FeatureKey)) {
      throw new BadRequestException(`feature_key inválido: ${featureKey}`)
    }
    if (!dto.primary_provider || !dto.primary_model) {
      throw new BadRequestException('primary_provider + primary_model obrigatórios')
    }
    if ((dto.fallback_provider && !dto.fallback_model) || (!dto.fallback_provider && dto.fallback_model)) {
      throw new BadRequestException('fallback_provider e fallback_model devem vir juntos')
    }

    const row = {
      organization_id:   orgId,
      feature_key:       featureKey,
      primary_provider:  dto.primary_provider,
      primary_model:     dto.primary_model,
      fallback_provider: dto.fallback_provider ?? null,
      fallback_model:    dto.fallback_model ?? null,
      enabled:           dto.enabled ?? true,
      updated_at:        new Date().toISOString(),
    }

    const { error } = await supabaseAdmin
      .from('ai_feature_settings')
      .upsert(row, { onConflict: 'organization_id,feature_key' })
    if (error) throw new BadRequestException(error.message)

    const list = await this.listForOrg(orgId)
    const out = list.find(x => x.feature_key === featureKey)
    if (!out) throw new BadRequestException('falha ao recuperar setting após upsert')
    return out
  }

  /** DELETE /ai/settings/:featureKey — volta pro default do registry. */
  async reset(orgId: string, featureKey: string): Promise<MergedFeatureSetting> {
    if (!FEATURE_KEYS.includes(featureKey as FeatureKey)) {
      throw new BadRequestException(`feature_key inválido: ${featureKey}`)
    }
    const { error } = await supabaseAdmin
      .from('ai_feature_settings')
      .delete()
      .eq('organization_id', orgId)
      .eq('feature_key', featureKey)
    if (error) throw new BadRequestException(error.message)

    const list = await this.listForOrg(orgId)
    return list.find(x => x.feature_key === featureKey)!  // sempre existe (do registry)
  }

  /** GET /ai/usage?days=30 — agregação pra Tab "Uso" do painel novo.
   * Faz tudo em memória depois de um SELECT bounded — N <= 5k rows. */
  async getUsage(orgId: string, days: number): Promise<{
    total: { tokens_input: number; tokens_output: number; cost_usd: number; calls: number; fallback_calls: number }
    by_feature:  Array<{ feature: string; calls: number; tokens_total: number; cost_usd: number }>
    by_provider: Array<{ provider: string; calls: number; cost_usd: number }>
    by_day:      Array<{ date: string; cost_usd: number; by_feature: Record<string, number> }>
  }> {
    const cap = Math.min(Math.max(days, 1), 90)
    const since = new Date(Date.now() - cap * 86_400_000).toISOString()

    const { data: rows } = await supabaseAdmin
      .from('ai_usage_log')
      .select('provider, model, feature, tokens_input, tokens_output, tokens_total, cost_usd, fallback_used, created_at')
      .eq('organization_id', orgId)
      .gte('created_at', since)
      .limit(5000)

    const all = (rows ?? []) as Array<{
      provider: string; model: string; feature: string
      tokens_input: number; tokens_output: number; tokens_total: number
      cost_usd: number; fallback_used: boolean; created_at: string
    }>

    let totalIn = 0, totalOut = 0, totalCost = 0, totalCalls = 0, fbCalls = 0
    const byFeature  = new Map<string, { calls: number; tokens_total: number; cost_usd: number }>()
    const byProvider = new Map<string, { calls: number; cost_usd: number }>()
    const byDay      = new Map<string, { cost_usd: number; by_feature: Record<string, number> }>()

    for (const r of all) {
      totalCalls++
      totalIn  += Number(r.tokens_input  ?? 0)
      totalOut += Number(r.tokens_output ?? 0)
      const cost = Number(r.cost_usd ?? 0)
      totalCost += cost
      if (r.fallback_used) fbCalls++

      const f = byFeature.get(r.feature) ?? { calls: 0, tokens_total: 0, cost_usd: 0 }
      f.calls++
      f.tokens_total += Number(r.tokens_total ?? 0)
      f.cost_usd     += cost
      byFeature.set(r.feature, f)

      const p = byProvider.get(r.provider) ?? { calls: 0, cost_usd: 0 }
      p.calls++
      p.cost_usd += cost
      byProvider.set(r.provider, p)

      const day = (r.created_at ?? '').slice(0, 10)
      if (!day) continue
      const d = byDay.get(day) ?? { cost_usd: 0, by_feature: {} }
      d.cost_usd += cost
      d.by_feature[r.feature] = (d.by_feature[r.feature] ?? 0) + cost
      byDay.set(day, d)
    }

    // Preenche dias zerados pra UI ter linha contínua no chart
    const byDayArr: Array<{ date: string; cost_usd: number; by_feature: Record<string, number> }> = []
    for (let i = cap - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)
      const v = byDay.get(d) ?? { cost_usd: 0, by_feature: {} }
      byDayArr.push({ date: d, cost_usd: Math.round(v.cost_usd * 1_000_000) / 1_000_000, by_feature: v.by_feature })
    }

    return {
      total: {
        tokens_input:   totalIn,
        tokens_output:  totalOut,
        cost_usd:       Math.round(totalCost * 1_000_000) / 1_000_000,
        calls:          totalCalls,
        fallback_calls: fbCalls,
      },
      by_feature:  [...byFeature].map(([feature, v])  => ({ feature, ...v })).sort((a, b) => b.cost_usd - a.cost_usd),
      by_provider: [...byProvider].map(([provider, v]) => ({ provider, ...v })).sort((a, b) => b.cost_usd - a.cost_usd),
      by_day:      byDayArr,
    }
  }
}
