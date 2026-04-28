import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { PricingPresetsService, PresetName, PresetPayload } from './pricing-presets.service'
import { PricingAuditService } from './pricing-audit.service'

export type PricingMode = 'disabled' | 'suggestion_only' | 'auto_with_limits' | 'full_auto'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any

export interface PricingConfig {
  id:               string
  organization_id:  string
  global_params:    Json
  abc_strategies:   Json
  triggers:         Json
  absolute_blocks:  Json
  confidence_rules: Json
  custom_rules:     Json
  mode:             PricingMode
  preset_name:      string | null
  chat_enabled:     boolean
  chat_model:       string
  created_at:       string
  updated_at:       string
}

export interface SeasonalPeriod {
  id:                     string
  organization_id:        string
  name:                   string
  category:               string | null
  start_date:             string
  end_date:               string
  pricing_adjustment_pct: number | null
  margin_override_pct:    number | null
  notes:                  string | null
  is_active:              boolean
  recurring_yearly:       boolean
  created_at:             string
}

export interface UntouchableSeller {
  id:                 string
  organization_id:    string
  seller_name:        string
  seller_id_external: string | null
  channel:            'mercadolivre' | 'shopee' | 'amazon' | 'magalu' | 'all' | null
  reason:             string | null
  created_at:         string
}

/** Top-level fields da config que podem ser editados via patch (incluindo
 * objetos/arrays JSONB). absolute_blocks é read-only por design. */
const EDITABLE_TOPS: Array<keyof PricingConfig> = [
  'global_params', 'abc_strategies', 'triggers',
  'confidence_rules', 'custom_rules',
  'mode', 'preset_name', 'chat_enabled', 'chat_model',
]

@Injectable()
export class PricingConfigService {
  private readonly logger = new Logger(PricingConfigService.name)

  constructor(
    private readonly presets: PricingPresetsService,
    private readonly audit:   PricingAuditService,
  ) {}

  // ── Config principal ────────────────────────────────────────────────────

  /** Pega config da org. Cria com defaults DB se não existir. */
  async getOrCreate(orgId: string): Promise<PricingConfig> {
    const { data: existing } = await supabaseAdmin
      .from('pricing_intelligence_config')
      .select('*')
      .eq('organization_id', orgId)
      .maybeSingle()
    if (existing) return existing as PricingConfig

    const { data, error } = await supabaseAdmin
      .from('pricing_intelligence_config')
      .insert({ organization_id: orgId })
      .select()
      .single()
    if (error) throw new BadRequestException(`create falhou: ${error.message}`)
    return data as PricingConfig
  }

  /** PATCH /pricing/config { path, value, reason? }. Path notation:
   * "abc_strategies.A.min_margin_pct" ou "triggers.decrease_price[0].active"
   * ou "mode" pra top-level. Faz deep merge: lê config atual, navega até
   * o path, seta o leaf, persiste o top-level inteiro. Loga audit. */
  async patchPath(
    orgId:      string,
    path:       string,
    value:      unknown,
    userId?:    string | null,
    reason?:    string | null,
  ): Promise<PricingConfig> {
    if (!path) throw new BadRequestException('path obrigatório')
    if (path.startsWith('absolute_blocks')) {
      throw new BadRequestException('absolute_blocks é read-only — bloqueios obrigatórios não editáveis')
    }

    const config = await this.getOrCreate(orgId)
    const segments = parsePath(path)
    if (segments.length === 0) throw new BadRequestException('path inválido')
    const top = String(segments[0]) as keyof PricingConfig
    if (!EDITABLE_TOPS.includes(top)) {
      throw new BadRequestException(`campo top-level "${top}" não editável`)
    }

    // Top-level scalar: muda direto
    if (segments.length === 1) {
      const oldValue = (config as unknown as Record<string, unknown>)[top]
      const update: Record<string, unknown> = { [top]: value, updated_at: new Date().toISOString() }
      // Se mudou algo via patch, marca preset como custom (a menos que seja preset_name explícito)
      if (top !== 'preset_name') update.preset_name = 'custom'
      const { data, error } = await supabaseAdmin
        .from('pricing_intelligence_config')
        .update(update)
        .eq('id', config.id)
        .select().single()
      if (error) throw new BadRequestException(error.message)
      await this.audit.log({
        orgId, configId: config.id, fieldPath: path,
        oldValue, newValue: value, changedBy: userId, reason,
      })
      return data as PricingConfig
    }

    // Deep path em JSONB: lê o objeto top, navega, seta, escreve top inteiro
    const topVal = deepClone((config as unknown as Record<string, unknown>)[top])
    if (topVal === null || typeof topVal !== 'object') {
      throw new BadRequestException(`field "${top}" não é objeto/array`)
    }
    const oldLeaf = setDeepPath(topVal, segments.slice(1), value)

    const update: Record<string, unknown> = {
      [top]: topVal,
      preset_name: 'custom',
      updated_at: new Date().toISOString(),
    }
    const { data, error } = await supabaseAdmin
      .from('pricing_intelligence_config')
      .update(update)
      .eq('id', config.id)
      .select().single()
    if (error) throw new BadRequestException(error.message)
    await this.audit.log({
      orgId, configId: config.id, fieldPath: path,
      oldValue: oldLeaf, newValue: value, changedBy: userId, reason,
    })
    return data as PricingConfig
  }

  /** POST /pricing/config/preset — sobrescreve campos do preset, mantendo
   * absolute_blocks/custom_rules/global_params (presets não tocam neles). */
  async applyPreset(
    orgId:    string,
    name:     PresetName,
    userId?:  string | null,
  ): Promise<PricingConfig> {
    if (!['conservador', 'equilibrado', 'agressivo'].includes(name)) {
      throw new BadRequestException(`preset "${name}" desconhecido`)
    }
    const config = await this.getOrCreate(orgId)
    const preset: PresetPayload = this.presets.get(name)

    const before = {
      mode:             config.mode,
      abc_strategies:   config.abc_strategies,
      triggers:         config.triggers,
      confidence_rules: config.confidence_rules,
    }

    const update = {
      mode:             preset.mode,
      abc_strategies:   preset.abc_strategies,
      triggers:         preset.triggers,
      confidence_rules: preset.confidence_rules,
      preset_name:      name,
      updated_at:       new Date().toISOString(),
    }

    const { data, error } = await supabaseAdmin
      .from('pricing_intelligence_config')
      .update(update)
      .eq('id', config.id)
      .select().single()
    if (error) throw new BadRequestException(error.message)

    // Audit em batch — 1 entry por top-field substituído
    await this.audit.logBatch([
      { orgId, configId: config.id, fieldPath: 'mode',             oldValue: before.mode,             newValue: preset.mode,             changedBy: userId, reason: `preset: ${name}` },
      { orgId, configId: config.id, fieldPath: 'abc_strategies',   oldValue: before.abc_strategies,   newValue: preset.abc_strategies,   changedBy: userId, reason: `preset: ${name}` },
      { orgId, configId: config.id, fieldPath: 'triggers',         oldValue: before.triggers,         newValue: preset.triggers,         changedBy: userId, reason: `preset: ${name}` },
      { orgId, configId: config.id, fieldPath: 'confidence_rules', oldValue: before.confidence_rules, newValue: preset.confidence_rules, changedBy: userId, reason: `preset: ${name}` },
      { orgId, configId: config.id, fieldPath: 'preset_name',      oldValue: config.preset_name,      newValue: name,                    changedBy: userId, reason: `preset: ${name}` },
    ])

    return data as PricingConfig
  }

  /** POST /pricing/config/reset — recria com defaults DB (DELETE + INSERT).
   * Loga audit com snapshot antigo de cada top-field. */
  async resetToDefaults(orgId: string, userId?: string | null): Promise<PricingConfig> {
    const config = await this.getOrCreate(orgId)
    const before = { ...config }

    // DELETE + INSERT pra forçar re-aplicação dos DEFAULTs do schema
    await supabaseAdmin.from('pricing_intelligence_config').delete().eq('id', config.id)
    const { data, error } = await supabaseAdmin
      .from('pricing_intelligence_config')
      .insert({ organization_id: orgId })
      .select().single()
    if (error) throw new BadRequestException(`reset falhou: ${error.message}`)
    const fresh = data as PricingConfig

    await this.audit.logBatch(
      EDITABLE_TOPS.map(field => ({
        orgId,
        configId:  fresh.id,
        fieldPath: String(field),
        oldValue:  (before as unknown as Record<string, unknown>)[field as string],
        newValue:  (fresh  as unknown as Record<string, unknown>)[field as string],
        changedBy: userId,
        reason:    'reset to defaults',
      })),
    )
    return fresh
  }

  // ── Sazonalidade ────────────────────────────────────────────────────────

  async listSeasonal(orgId: string): Promise<SeasonalPeriod[]> {
    const { data, error } = await supabaseAdmin
      .from('pricing_seasonal_periods').select('*')
      .eq('organization_id', orgId)
      .order('start_date', { ascending: true })
    if (error) throw new BadRequestException(error.message)
    return (data ?? []) as SeasonalPeriod[]
  }

  async createSeasonal(orgId: string, input: Partial<SeasonalPeriod>): Promise<SeasonalPeriod> {
    if (!input.name)       throw new BadRequestException('name obrigatório')
    if (!input.start_date) throw new BadRequestException('start_date obrigatório')
    if (!input.end_date)   throw new BadRequestException('end_date obrigatório')
    const row = {
      organization_id:        orgId,
      name:                   input.name,
      category:               input.category               ?? null,
      start_date:             input.start_date,
      end_date:               input.end_date,
      pricing_adjustment_pct: input.pricing_adjustment_pct ?? null,
      margin_override_pct:    input.margin_override_pct    ?? null,
      notes:                  input.notes                  ?? null,
      is_active:              input.is_active              ?? true,
      recurring_yearly:       input.recurring_yearly       ?? false,
    }
    const { data, error } = await supabaseAdmin
      .from('pricing_seasonal_periods').insert(row).select().single()
    if (error) throw new BadRequestException(error.message)
    return data as SeasonalPeriod
  }

  async updateSeasonal(orgId: string, id: string, patch: Partial<SeasonalPeriod>): Promise<SeasonalPeriod> {
    const update: Record<string, unknown> = {}
    for (const k of ['name','category','start_date','end_date','pricing_adjustment_pct','margin_override_pct','notes','is_active','recurring_yearly'] as const) {
      if (patch[k] !== undefined) update[k] = patch[k]
    }
    const { data, error } = await supabaseAdmin
      .from('pricing_seasonal_periods').update(update)
      .eq('id', id).eq('organization_id', orgId)
      .select().single()
    if (error) throw new BadRequestException(error.message)
    if (!data)  throw new NotFoundException('período não encontrado')
    return data as SeasonalPeriod
  }

  async deleteSeasonal(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('pricing_seasonal_periods').delete()
      .eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)
    return { ok: true }
  }

  // ── Vendedores intocáveis ───────────────────────────────────────────────

  async listUntouchable(orgId: string): Promise<UntouchableSeller[]> {
    const { data, error } = await supabaseAdmin
      .from('pricing_untouchable_sellers').select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    if (error) throw new BadRequestException(error.message)
    return (data ?? []) as UntouchableSeller[]
  }

  async createUntouchable(orgId: string, input: Partial<UntouchableSeller>): Promise<UntouchableSeller> {
    if (!input.seller_name) throw new BadRequestException('seller_name obrigatório')
    const row = {
      organization_id:    orgId,
      seller_name:        input.seller_name,
      seller_id_external: input.seller_id_external ?? null,
      channel:            input.channel ?? 'all',
      reason:             input.reason  ?? null,
    }
    const { data, error } = await supabaseAdmin
      .from('pricing_untouchable_sellers').insert(row).select().single()
    if (error) throw new BadRequestException(error.message)
    return data as UntouchableSeller
  }

  async deleteUntouchable(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('pricing_untouchable_sellers').delete()
      .eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)
    return { ok: true }
  }
}

// ── Path-walking helpers (não exportados) ───────────────────────────────────

/** "a.b[0].c" → ['a', 'b', 0, 'c']. Suporta nesting arbitrário com [N]. */
function parsePath(path: string): Array<string | number> {
  const out: Array<string | number> = []
  const parts = path.split('.')
  for (const part of parts) {
    const m = part.match(/^([^[\]]+)(?:\[(\d+)\])*$/)
    if (!m) { out.push(part); continue }
    out.push(m[1])
    const arrayIdx = part.matchAll(/\[(\d+)\]/g)
    for (const ai of arrayIdx) out.push(Number(ai[1]))
  }
  return out
}

/** Navega target seguindo segments (até o penúltimo) e seta o último.
 * Retorna o valor antigo do leaf. Mutação in-place. */
function setDeepPath(target: unknown, segments: Array<string | number>, value: unknown): unknown {
  let cur: unknown = target
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    if (cur === null || typeof cur !== 'object') {
      throw new BadRequestException(`path inválido: tentando navegar dentro de ${typeof cur}`)
    }
    cur = (cur as Record<string | number, unknown>)[seg as string | number]
  }
  if (cur === null || typeof cur !== 'object') {
    throw new BadRequestException('path inválido: parent leaf não é objeto')
  }
  const lastSeg = segments[segments.length - 1]
  const obj = cur as Record<string | number, unknown>
  const oldValue = obj[lastSeg as string | number]
  obj[lastSeg as string | number] = value
  return oldValue
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
