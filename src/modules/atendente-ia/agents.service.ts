import { Injectable, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

@Injectable()
export class AgentsService {

  // ── Agents ────────────────────────────────────────────────────────────────

  async listAgents(orgId: string) {
    const { data, error } = await supabaseAdmin
      .from('ai_agents')
      .select(`
        *,
        channels:ai_agent_channels(channel, is_active, mode)
      `)
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })

    if (error) throw error
    return data ?? []
  }

  async getAgent(orgId: string, agentId: string) {
    const { data, error } = await supabaseAdmin
      .from('ai_agents')
      .select(`
        *,
        channels:ai_agent_channels(*),
        knowledge:ai_knowledge_base(*)
      `)
      .eq('id', agentId)
      .eq('organization_id', orgId)
      .single()

    if (error) throw new NotFoundException('Agente não encontrado')
    return data
  }

  async createAgent(orgId: string, body: {
    name: string
    description?: string
    avatar_url?: string
    model_provider?: string
    model_id?: string
    system_prompt?: string
    tone?: string
    language?: string
    response_delay_seconds?: number
  }) {
    const { data, error } = await supabaseAdmin
      .from('ai_agents')
      .insert({ ...body, organization_id: orgId })
      .select()
      .single()

    if (error) throw error
    return data
  }

  async updateAgent(orgId: string, agentId: string, body: Partial<{
    name: string
    description: string
    avatar_url: string
    model_provider: string
    model_id: string
    system_prompt: string
    tone: string
    language: string
    response_delay_seconds: number
    is_active: boolean
  }>) {
    const { data, error } = await supabaseAdmin
      .from('ai_agents')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', agentId)
      .eq('organization_id', orgId)
      .select()
      .single()

    if (error) throw error
    return data
  }

  async toggleAgent(orgId: string, agentId: string) {
    const { data: current } = await supabaseAdmin
      .from('ai_agents')
      .select('is_active')
      .eq('id', agentId)
      .eq('organization_id', orgId)
      .single()

    return this.updateAgent(orgId, agentId, { is_active: !current?.is_active })
  }

  async deleteAgent(orgId: string, agentId: string) {
    const { error } = await supabaseAdmin
      .from('ai_agents')
      .delete()
      .eq('id', agentId)
      .eq('organization_id', orgId)

    if (error) throw error
    return { ok: true }
  }

  // ── Channels ──────────────────────────────────────────────────────────────

  async upsertChannel(agentId: string, channel: string, body: {
    mode?: string
    is_active?: boolean
    confidence_threshold?: number
    auto_reply_delay_seconds?: number
    max_response_length?: number
    escalate_keywords?: string[]
    working_hours_start?: string
    working_hours_end?: string
    working_days?: number[]
    outside_hours_message?: string
  }) {
    const { data, error } = await supabaseAdmin
      .from('ai_agent_channels')
      .upsert({ agent_id: agentId, channel, ...body }, { onConflict: 'agent_id,channel' })
      .select()
      .single()

    if (error) throw error
    return data
  }

  async deleteChannel(agentId: string, channel: string) {
    const { error } = await supabaseAdmin
      .from('ai_agent_channels')
      .delete()
      .eq('agent_id', agentId)
      .eq('channel', channel)

    if (error) throw error
    return { ok: true }
  }

  // ── Knowledge ─────────────────────────────────────────────────────────────

  async listKnowledge(agentId: string) {
    const { data, error } = await supabaseAdmin
      .from('ai_knowledge_base')
      .select('*')
      .eq('agent_id', agentId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })

    if (error) throw error
    return data ?? []
  }

  async createKnowledge(agentId: string, body: {
    type: string
    title: string
    content: string
    tags?: string[]
  }) {
    const { data, error } = await supabaseAdmin
      .from('ai_knowledge_base')
      .insert({ agent_id: agentId, ...body })
      .select()
      .single()

    if (error) throw error
    return data
  }

  async updateKnowledge(knowledgeId: string, body: Partial<{
    title: string
    content: string
    tags: string[]
    is_active: boolean
  }>) {
    const { data, error } = await supabaseAdmin
      .from('ai_knowledge_base')
      .update(body)
      .eq('id', knowledgeId)
      .select()
      .single()

    if (error) throw error
    return data
  }

  async deleteKnowledge(knowledgeId: string) {
    const { error } = await supabaseAdmin
      .from('ai_knowledge_base')
      .delete()
      .eq('id', knowledgeId)

    if (error) throw error
    return { ok: true }
  }

  // ── Training examples ─────────────────────────────────────────────────────

  async listTraining(agentId: string) {
    const { data, error } = await supabaseAdmin
      .from('ai_training_examples')
      .select('*')
      .eq('agent_id', agentId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })

    if (error) throw error
    return data ?? []
  }

  async createTraining(agentId: string, body: {
    question: string
    ideal_answer: string
    category?: string
    source?: string
  }) {
    const { data, error } = await supabaseAdmin
      .from('ai_training_examples')
      .insert({ agent_id: agentId, ...body })
      .select()
      .single()

    if (error) throw error
    return data
  }

  async deleteTraining(trainingId: string) {
    const { error } = await supabaseAdmin
      .from('ai_training_examples')
      .delete()
      .eq('id', trainingId)

    if (error) throw error
    return { ok: true }
  }

  /**
   * Mark a training example as validated by a human reviewer.
   * Convention: source='validated' means a human looked at it and approved.
   * Defaults to 'manual' creation, becomes 'human_edit' when auto-captured
   * from a /conversas edit, and 'validated' once a human confirms.
   */
  async validateTraining(trainingId: string) {
    const { data, error } = await supabaseAdmin
      .from('ai_training_examples')
      .update({ source: 'validated' })
      .eq('id', trainingId)
      .select()
      .single()
    if (error) throw error
    return data
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  async getAnalytics(agentId: string, from: string, to: string) {
    const { data, error } = await supabaseAdmin
      .from('ai_agent_analytics')
      .select('*')
      .eq('agent_id', agentId)
      .gte('date', from)
      .lte('date', to)
      .order('date', { ascending: true })

    if (error) throw error
    return data ?? []
  }
}
