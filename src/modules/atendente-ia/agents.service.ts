import { Injectable, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

@Injectable()
export class AgentsService {

  // ── Helpers de validação cross-org ─────────────────────────────────────
  // Antes: serviços assumiam que o caller passou o agentId/knowledgeId
  // certo e nunca validavam org. IDOR clássico — qualquer user logado
  // podia /atendente-ia/agents/<id-de-outra-org>/knowledge e acessar/editar.
  private async assertAgentInOrg(orgId: string, agentId: string): Promise<void> {
    const { data } = await supabaseAdmin
      .from('ai_agents').select('id').eq('id', agentId).eq('organization_id', orgId).maybeSingle()
    if (!data) throw new NotFoundException('Agente não encontrado')
  }

  private async assertKnowledgeInOrg(orgId: string, knowledgeId: string): Promise<void> {
    const { data } = await supabaseAdmin
      .from('ai_knowledge_base').select('id').eq('id', knowledgeId).eq('organization_id', orgId).maybeSingle()
    if (!data) throw new NotFoundException('Conteúdo não encontrado')
  }

  private async assertTrainingInOrg(orgId: string, trainingId: string): Promise<void> {
    const { data } = await supabaseAdmin
      .from('ai_training_examples').select('id').eq('id', trainingId).eq('organization_id', orgId).maybeSingle()
    if (!data) throw new NotFoundException('Exemplo não encontrado')
  }

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

  async upsertChannel(orgId: string, agentId: string, channel: string, body: {
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
    await this.assertAgentInOrg(orgId, agentId)
    const { data, error } = await supabaseAdmin
      .from('ai_agent_channels')
      .upsert(
        { agent_id: agentId, organization_id: orgId, channel, ...body },
        { onConflict: 'agent_id,channel' },
      )
      .select()
      .single()

    if (error) throw error
    return data
  }

  async deleteChannel(orgId: string, agentId: string, channel: string) {
    await this.assertAgentInOrg(orgId, agentId)
    const { error } = await supabaseAdmin
      .from('ai_agent_channels')
      .delete()
      .eq('organization_id', orgId)
      .eq('agent_id', agentId)
      .eq('channel', channel)

    if (error) throw error
    return { ok: true }
  }

  // ── Knowledge ─────────────────────────────────────────────────────────────

  async listKnowledge(orgId: string, agentId: string) {
    await this.assertAgentInOrg(orgId, agentId)
    // M:M é a única fonte (legacy ai_knowledge_base.agent_id removido em AI-6).
    const { data: links } = await supabaseAdmin
      .from('ai_agent_knowledge')
      .select('knowledge_id')
      .eq('organization_id', orgId)
      .eq('agent_id', agentId)
    const linkedIds = (links ?? []).map(r => r.knowledge_id as string)
    if (!linkedIds.length) return []

    const { data, error } = await supabaseAdmin
      .from('ai_knowledge_base')
      .select('*')
      .eq('organization_id', orgId)
      .eq('is_active', true)
      .in('id', linkedIds)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data ?? []
  }

  async createKnowledge(orgId: string, agentId: string, body: {
    type: string
    title: string
    content: string
    tags?: string[]
  }) {
    await this.assertAgentInOrg(orgId, agentId)
    const { data, error } = await supabaseAdmin
      .from('ai_knowledge_base')
      .insert({ organization_id: orgId, ...body })
      .select()
      .single()

    if (error) throw error

    // Linka via M:M (única fonte agora — legacy agent_id removido em AI-6)
    if (data?.id) {
      await supabaseAdmin
        .from('ai_agent_knowledge')
        .upsert(
          { agent_id: agentId, knowledge_id: data.id, organization_id: orgId },
          { onConflict: 'agent_id,knowledge_id' },
        )
    }
    return data
  }

  async updateKnowledge(orgId: string, knowledgeId: string, body: Partial<{
    title: string
    content: string
    tags: string[]
    is_active: boolean
  }>) {
    await this.assertKnowledgeInOrg(orgId, knowledgeId)
    const { data, error } = await supabaseAdmin
      .from('ai_knowledge_base')
      .update(body)
      .eq('id', knowledgeId)
      .eq('organization_id', orgId)
      .select()
      .single()

    if (error) throw error
    return data
  }

  async deleteKnowledge(orgId: string, knowledgeId: string) {
    await this.assertKnowledgeInOrg(orgId, knowledgeId)
    const { error } = await supabaseAdmin
      .from('ai_knowledge_base')
      .delete()
      .eq('id', knowledgeId)
      .eq('organization_id', orgId)

    if (error) throw error
    return { ok: true }
  }

  // ── Training examples ─────────────────────────────────────────────────────

  async listTraining(orgId: string, agentId: string) {
    await this.assertAgentInOrg(orgId, agentId)
    const { data, error } = await supabaseAdmin
      .from('ai_training_examples')
      .select('*')
      .eq('organization_id', orgId)
      .eq('agent_id', agentId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })

    if (error) throw error
    return data ?? []
  }

  async createTraining(orgId: string, agentId: string, body: {
    question: string
    ideal_answer: string
    category?: string
    source?: string
  }) {
    await this.assertAgentInOrg(orgId, agentId)
    const { data, error } = await supabaseAdmin
      .from('ai_training_examples')
      .insert({ agent_id: agentId, organization_id: orgId, ...body })
      .select()
      .single()

    if (error) throw error
    return data
  }

  async deleteTraining(orgId: string, trainingId: string) {
    await this.assertTrainingInOrg(orgId, trainingId)
    const { error } = await supabaseAdmin
      .from('ai_training_examples')
      .delete()
      .eq('id', trainingId)
      .eq('organization_id', orgId)

    if (error) throw error
    return { ok: true }
  }

  /**
   * Mark a training example as validated by a human reviewer.
   * Convention: source='validated' means a human looked at it and approved.
   * Defaults to 'manual' creation, becomes 'human_edit' when auto-captured
   * from a /conversas edit, and 'validated' once a human confirms.
   */
  async validateTraining(orgId: string, trainingId: string) {
    await this.assertTrainingInOrg(orgId, trainingId)
    const { data, error } = await supabaseAdmin
      .from('ai_training_examples')
      .update({ source: 'validated' })
      .eq('id', trainingId)
      .eq('organization_id', orgId)
      .select()
      .single()
    if (error) throw error
    return data
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  async getAnalytics(orgId: string, agentId: string, from: string, to: string) {
    await this.assertAgentInOrg(orgId, agentId)
    const { data, error } = await supabaseAdmin
      .from('ai_agent_analytics')
      .select('*')
      .eq('organization_id', orgId)
      .eq('agent_id', agentId)
      .gte('date', from)
      .lte('date', to)
      .order('date', { ascending: true })

    if (error) throw error
    return data ?? []
  }
}
