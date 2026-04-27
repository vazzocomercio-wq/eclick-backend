import { Injectable, HttpException, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

export interface AdsAiSettings {
  organization_id: string
  model_provider: string
  model_id: string
  acos_alert_threshold: number
  roas_min_threshold: number
  ctr_drop_threshold: number
  budget_burn_threshold: number
  stock_critical_days: number
  whatsapp_alerts_enabled: boolean
  whatsapp_alert_phone: string | null
  whatsapp_alert_severity: string
  auto_detect_enabled: boolean
  detect_cron_minutes: number
}

const DEFAULTS: Omit<AdsAiSettings, 'organization_id'> = {
  model_provider:           'anthropic',
  model_id:                 'claude-haiku-4-5-20251001',
  acos_alert_threshold:     30.0,
  roas_min_threshold:       2.0,
  ctr_drop_threshold:       30.0,
  budget_burn_threshold:    80.0,
  stock_critical_days:      7,
  whatsapp_alerts_enabled:  false,
  whatsapp_alert_phone:     null,
  whatsapp_alert_severity:  'high',
  auto_detect_enabled:      true,
  detect_cron_minutes:      60,
}

export interface ModelOption {
  provider: string
  id: string
  label: string
  tier: 'fast' | 'balanced' | 'premium'
  input_cost_per_1m_usd:  number
  output_cost_per_1m_usd: number
  notes?: string
}

const MODELS: ModelOption[] = [
  { provider: 'anthropic', id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5',
    tier: 'fast',     input_cost_per_1m_usd: 0.80,  output_cost_per_1m_usd: 4.00,
    notes: 'Mais rápido, ideal pra detecção contínua e queries simples' },
  { provider: 'anthropic', id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6',
    tier: 'balanced', input_cost_per_1m_usd: 3.00,  output_cost_per_1m_usd: 15.00,
    notes: 'Equilibrado, bom pra análises do dia a dia' },
  { provider: 'anthropic', id: 'claude-opus-4-7',           label: 'Claude Opus 4.7',
    tier: 'premium',  input_cost_per_1m_usd: 15.00, output_cost_per_1m_usd: 75.00,
    notes: 'Mais inteligente, pra estratégia + casos complexos' },
]

@Injectable()
export class AdsAiService {
  private readonly logger = new Logger(AdsAiService.name)

  // ── Settings ──
  async getSettings(orgId: string): Promise<AdsAiSettings> {
    const { data } = await supabaseAdmin
      .from('ads_ai_settings').select('*').eq('organization_id', orgId).maybeSingle()
    if (data) return data as AdsAiSettings
    return { organization_id: orgId, ...DEFAULTS }
  }

  async updateSettings(orgId: string, patch: Partial<AdsAiSettings>): Promise<AdsAiSettings> {
    const cur = await this.getSettings(orgId)
    const merged = { ...cur, ...patch, organization_id: orgId, updated_at: new Date().toISOString() }
    const { data, error } = await supabaseAdmin
      .from('ads_ai_settings').upsert(merged, { onConflict: 'organization_id' })
      .select().single()
    if (error) throw new HttpException(error.message, 500)
    return data as AdsAiSettings
  }

  availableModels(): ModelOption[] { return MODELS }

  // ── Insights (read/CRUD only — detection lives in InsightDetectorService) ──
  async listInsights(orgId: string, filters: { status?: string; severity?: string; type?: string } = {}) {
    let q = supabaseAdmin
      .from('ads_ai_insights').select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(200)
    if (filters.status)   q = q.eq('status', filters.status)
    if (filters.severity) q = q.eq('severity', filters.severity)
    if (filters.type)     q = q.eq('type', filters.type)
    const { data, error } = await q
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async dismissInsight(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin
      .from('ads_ai_insights')
      .update({ status: 'dismissed', dismissed_at: new Date().toISOString() })
      .eq('id', id).eq('organization_id', orgId)
      .select().single()
    if (error) throw new HttpException(error.message, 500)
    return data
  }

  async resolveInsight(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin
      .from('ads_ai_insights')
      .update({ status: 'resolved', resolved_at: new Date().toISOString() })
      .eq('id', id).eq('organization_id', orgId)
      .select().single()
    if (error) throw new HttpException(error.message, 500)
    return data
  }

  // ── Conversations / Messages ──
  async listConversations(orgId: string) {
    const { data, error } = await supabaseAdmin
      .from('ads_ai_conversations').select('*')
      .eq('organization_id', orgId)
      .order('updated_at', { ascending: false })
      .limit(50)
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async createConversation(orgId: string, userId: string | null, title: string | null, model: string | null) {
    const { data, error } = await supabaseAdmin
      .from('ads_ai_conversations')
      .insert({ organization_id: orgId, user_id: userId, title: title ?? 'Nova conversa', model_used: model })
      .select().single()
    if (error) throw new HttpException(error.message, 500)
    return data
  }

  async listMessages(orgId: string, convId: string) {
    // Verify conversation belongs to org first.
    const { data: conv } = await supabaseAdmin
      .from('ads_ai_conversations').select('id').eq('id', convId).eq('organization_id', orgId).maybeSingle()
    if (!conv) return []
    const { data, error } = await supabaseAdmin
      .from('ads_ai_messages').select('*').eq('conversation_id', convId).order('created_at', { ascending: true })
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }
}
