import { Injectable, HttpException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { AI_PROVIDERS, AiProviderDef } from '../../constants/ai-models'

export interface AiModuleSettings {
  id?: number
  show_cost_estimates?: boolean
  classifier_provider?: string
  classifier_model?: string
  embedding_provider?: string
  embedding_model?: string
  auto_send_threshold?: number
  queue_threshold?: number
  // 5 wave-1 sessão 3 UI toggles (require ALTER from
  // 20260426_ai_module_settings_toggles.sql)
  show_tokens?: boolean
  capture_edits?: boolean
  auto_retrain?: boolean
  notify_escalation?: boolean
  notify_daily?: boolean
}

@Injectable()
export class AiSettingsService {
  /**
   * Returns the providers from the embedded catalog filtered to those that
   * have at least one credential row in api_credentials. UI uses this to
   * populate the model selector — no point letting the user pick Claude
   * if no Anthropic key is configured.
   */
  async listAvailableProviders(): Promise<AiProviderDef[]> {
    const { data, error } = await supabaseAdmin
      .from('api_credentials')
      .select('provider')
      .eq('is_active', true)

    if (error) throw new HttpException(error.message, 500)
    const connected = new Set((data ?? []).map(r => r.provider as string))
    return AI_PROVIDERS.filter(p => connected.has(p.id))
  }

  // ── Module settings (per-org row, UNIQUE organization_id) ─────────────────
  // Antes era singleton id=1 — todas orgs compartilhavam thresholds. Migrado
  // em 20260505_ai_module_settings_per_org.sql.

  private static DEFAULTS: AiModuleSettings = {
    show_cost_estimates: false,
    classifier_provider: 'anthropic',
    classifier_model:    'claude-haiku-4-5-20251001',
    embedding_provider:  'openai',
    embedding_model:     'text-embedding-3-small',
    auto_send_threshold: 80,
    queue_threshold:     50,
    show_tokens:         true,
    capture_edits:       true,
    auto_retrain:        false,
    notify_escalation:   true,
    notify_daily:        false,
  }

  async getSettings(orgId: string): Promise<AiModuleSettings> {
    if (!orgId) throw new HttpException('getSettings: orgId obrigatório', 400)
    const { data, error } = await supabaseAdmin
      .from('ai_module_settings')
      .select('*')
      .eq('organization_id', orgId)
      .maybeSingle()

    if (error) throw new HttpException(error.message, 500)
    if (!data) {
      // Org sem linha (criada após a migration?) — retorna defaults sem persistir
      // pra evitar race condition. updateSettings cria sob demanda.
      return AiSettingsService.DEFAULTS
    }
    return data as AiModuleSettings
  }

  async updateSettings(orgId: string, updates: AiModuleSettings): Promise<AiModuleSettings> {
    if (!orgId) throw new HttpException('updateSettings: orgId obrigatório', 400)
    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const k of [
      'show_cost_estimates', 'classifier_provider', 'classifier_model',
      'embedding_provider', 'embedding_model', 'auto_send_threshold', 'queue_threshold',
      'show_tokens', 'capture_edits', 'auto_retrain', 'notify_escalation', 'notify_daily',
    ] as const) {
      if (updates[k] !== undefined) payload[k] = updates[k]
    }

    // upsert por organization_id (UNIQUE)
    const { data, error } = await supabaseAdmin
      .from('ai_module_settings')
      .upsert(
        { organization_id: orgId, ...AiSettingsService.DEFAULTS, ...payload },
        { onConflict: 'organization_id' },
      )
      .select()
      .single()

    if (error) throw new HttpException(error.message, 400)
    return data as AiModuleSettings
  }

  // ── Templates (read from ai_agent_templates) ──────────────────────────────

  async listTemplates() {
    const { data, error } = await supabaseAdmin
      .from('ai_agent_templates')
      .select('*')
      .order('id', { ascending: true })
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async getTemplate(id: string) {
    const { data, error } = await supabaseAdmin
      .from('ai_agent_templates')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) throw new HttpException(error.message, 500)
    if (!data) throw new NotFoundException(`Template "${id}" não encontrado`)
    return data
  }

  /**
   * Create an agent pre-filled from a template. Caller can override any
   * field via `overrides`. Returns the new agent row.
   */
  async createAgentFromTemplate(
    templateId: string,
    orgId: string,
    overrides: { name?: string; description?: string; system_prompt?: string; model_provider?: string; model_id?: string } = {},
  ) {
    const tpl = await this.getTemplate(templateId)

    const payload = {
      organization_id:  orgId,
      name:             overrides.name           ?? `${tpl.name} ${tpl.emoji ?? ''}`.trim(),
      description:      overrides.description    ?? tpl.description,
      system_prompt:    overrides.system_prompt  ?? tpl.default_prompt,
      model_provider:   overrides.model_provider ?? tpl.default_provider,
      model_id:         overrides.model_id       ?? tpl.default_model,
      is_active:        true,
    }

    const { data, error } = await supabaseAdmin
      .from('ai_agents')
      .insert(payload)
      .select()
      .single()

    if (error) throw new HttpException(error.message, 400)
    return data
  }
}
