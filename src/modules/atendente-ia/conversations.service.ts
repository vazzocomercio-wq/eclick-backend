import { Injectable } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'

@Injectable()
export class ConversationsService {
  constructor(private readonly mlService: MercadolivreService) {}

  async list(filters: {
    orgId: string
    status?: string
    channel?: string
    agent_id?: string
    search?: string
    limit?: number
    offset?: number
  }) {
    let q = supabaseAdmin
      .from('ai_conversations')
      .select(`
        *,
        agent:ai_agents(id, name, avatar_url),
        last_message:ai_messages(content, role, sent_at)
      `, { count: 'exact' })
      .order('updated_at', { ascending: false })
      .limit(filters.limit ?? 50)
      .range(filters.offset ?? 0, (filters.offset ?? 0) + (filters.limit ?? 50) - 1)

    if (filters.status && filters.status !== 'all') q = q.eq('status', filters.status)
    if (filters.channel) q = q.eq('channel', filters.channel)
    if (filters.agent_id) q = q.eq('agent_id', filters.agent_id)
    if (filters.search) q = q.or(`customer_name.ilike.%${filters.search}%,listing_title.ilike.%${filters.search}%`)

    const { data, error, count } = await q
    if (error) throw error
    return { conversations: data ?? [], total: count ?? 0 }
  }

  async getConversation(id: string) {
    const { data, error } = await supabaseAdmin
      .from('ai_conversations')
      .select(`
        *,
        agent:ai_agents(id, name, avatar_url, model_provider, model_id, tone),
        channel_config:ai_agent_channels(*)
      `)
      .eq('id', id)
      .single()

    if (error) throw error
    return data
  }

  async getMessages(conversationId: string) {
    const { data, error } = await supabaseAdmin
      .from('ai_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('sent_at', { ascending: true })

    if (error) throw error
    return data ?? []
  }

  async sendHumanMessage(conversationId: string, userId: string, content: string) {
    const { data: msg, error } = await supabaseAdmin
      .from('ai_messages')
      .insert({
        conversation_id: conversationId,
        role:            'human',
        content,
        was_approved_by: userId,
      })
      .select()
      .single()

    if (error) throw error

    const { data: conv } = await supabaseAdmin
      .from('ai_conversations')
      .select('total_messages')
      .eq('id', conversationId)
      .single()

    await supabaseAdmin
      .from('ai_conversations')
      .update({
        updated_at:     new Date().toISOString(),
        total_messages: (conv?.total_messages ?? 0) + 1,
        status:         'waiting_customer',
      })
      .eq('id', conversationId)

    return msg
  }

  async approveSuggestion(conversationId: string, messageId: string, userId: string, editedContent?: string) {
    // 1. Fetch original message content for sending
    const { data: message } = await supabaseAdmin
      .from('ai_messages')
      .select('content')
      .eq('id', messageId)
      .maybeSingle()

    const contentToSend = editedContent || message?.content || ''

    // 2. Update the AI message
    const update: Record<string, unknown> = {
      was_auto_sent:   true,
      was_approved_by: userId,
    }
    if (editedContent) {
      update.content              = editedContent
      update.was_edited_before_send = true
    }

    const { data, error } = await supabaseAdmin
      .from('ai_messages')
      .update(update)
      .eq('id', messageId)
      .select()
      .single()

    if (error) throw error

    // 3. Fetch conversation for channel + external id
    const { data: conv } = await supabaseAdmin
      .from('ai_conversations')
      .select('channel, external_conversation_id')
      .eq('id', conversationId)
      .maybeSingle()

    // 4. Send to ML if applicable
    if (conv?.channel === 'mercadolivre' && conv.external_conversation_id) {
      try {
        await this.mlService.answerQuestion(
          null,
          Number(conv.external_conversation_id),
          contentToSend,
        )
      } catch (e: any) {
        console.error('[approve] erro ao enviar ML:', e.message)
        // Don't throw — message is approved even if ML delivery fails
      }
    }

    // 5. Resolve conversation
    await supabaseAdmin
      .from('ai_conversations')
      .update({
        status:      'resolved',
        resolved_at: new Date().toISOString(),
        updated_at:  new Date().toISOString(),
      })
      .eq('id', conversationId)

    return data
  }

  async discardSuggestion(conversationId: string, messageId: string) {
    await supabaseAdmin
      .from('ai_messages')
      .delete()
      .eq('id', messageId)
      .eq('conversation_id', conversationId)

    await supabaseAdmin
      .from('ai_conversations')
      .update({ status: 'open', updated_at: new Date().toISOString() })
      .eq('id', conversationId)

    return { ok: true }
  }

  async resolve(conversationId: string) {
    const { data, error } = await supabaseAdmin
      .from('ai_conversations')
      .update({
        status:      'resolved',
        resolved_at: new Date().toISOString(),
        updated_at:  new Date().toISOString(),
      })
      .eq('id', conversationId)
      .select()
      .single()

    if (error) throw error
    return data
  }

  async escalate(conversationId: string, assignTo?: string) {
    const { data, error } = await supabaseAdmin
      .from('ai_conversations')
      .update({
        status:     'escalated',
        priority:   'high',
        assigned_to: assignTo ?? null,
        updated_at:  new Date().toISOString(),
      })
      .eq('id', conversationId)
      .select()
      .single()

    if (error) throw error
    return data
  }

  async upsertConversation(conv: {
    agent_id?: string
    channel: string
    external_conversation_id: string
    external_customer_id?: string
    customer_name?: string
    customer_nickname?: string
    listing_id?: string
    listing_title?: string
  }) {
    const { data, error } = await supabaseAdmin
      .from('ai_conversations')
      .upsert(
        { ...conv, updated_at: new Date().toISOString() },
        { onConflict: 'channel,external_conversation_id', ignoreDuplicates: false },
      )
      .select()
      .single()

    if (error) throw error
    return data
  }

  async addMessage(msg: {
    conversation_id: string
    role: string
    content: string
    ai_provider?: string
    ai_model?: string
    ai_confidence?: number
    ai_reasoning?: string
    was_auto_sent?: boolean
    external_message_id?: string
  }) {
    const { data, error } = await supabaseAdmin
      .from('ai_messages')
      .insert(msg)
      .select()
      .single()

    if (error) throw error

    const { data: conv } = await supabaseAdmin
      .from('ai_conversations')
      .select('total_messages, auto_replied_count')
      .eq('id', msg.conversation_id)
      .single()

    await supabaseAdmin
      .from('ai_conversations')
      .update({
        updated_at:     new Date().toISOString(),
        total_messages: (conv?.total_messages ?? 0) + 1,
        ...(msg.was_auto_sent ? { auto_replied_count: (conv?.auto_replied_count ?? 0) + 1 } : {}),
        status: msg.was_auto_sent ? 'waiting_customer' : 'waiting_human',
      })
      .eq('id', msg.conversation_id)

    return data
  }

  // ── Analytics aggregations (used by /analytics page) ──────────────────────

  /**
   * Top-N most frequent customer questions across all conversations of an org.
   * Groups by lowercased content prefix (60 chars) so "Bivolt?" and "bivolt?"
   * count together. Naive but useful for the FAQ extraction UX.
   */
  async topQuestions(orgId: string, limit = 10) {
    const { data: convs } = await supabaseAdmin
      .from('ai_conversations')
      .select('id')
      .eq('organization_id', orgId)
    const convIds = (convs ?? []).map(c => c.id as string)
    if (!convIds.length) return []

    const { data: msgs } = await supabaseAdmin
      .from('ai_messages')
      .select('content, sent_at')
      .eq('role', 'customer')
      .in('conversation_id', convIds)
      .order('sent_at', { ascending: false })
      .limit(2000)

    const counts = new Map<string, { sample: string; count: number; lastAt: string }>()
    for (const m of msgs ?? []) {
      const raw = (m.content as string ?? '').trim()
      if (raw.length < 8) continue
      const key = raw.toLowerCase().slice(0, 60)
      const existing = counts.get(key)
      if (existing) {
        existing.count++
        if ((m.sent_at as string) > existing.lastAt) existing.lastAt = m.sent_at as string
      } else {
        counts.set(key, { sample: raw, count: 1, lastAt: m.sent_at as string })
      }
    }
    return Array.from(counts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map(x => ({ question: x.sample, count: x.count, last_at: x.lastAt }))
  }

  /**
   * Performance comparison row per agent over the last `days` window.
   * Reads from ai_agent_analytics (already aggregated daily).
   */
  async performanceByAgent(orgId: string, days = 30) {
    const { data: agents } = await supabaseAdmin
      .from('ai_agents')
      .select('id, name, model_id')
      .eq('organization_id', orgId)
    if (!agents?.length) return []

    const since = new Date(Date.now() - days * 86400 * 1000).toISOString().split('T')[0]
    const ids = agents.map(a => a.id as string)
    const { data: analytics } = await supabaseAdmin
      .from('ai_agent_analytics')
      .select('agent_id, messages_received, messages_auto_replied, messages_escalated, avg_confidence')
      .in('agent_id', ids)
      .gte('date', since)

    const byAgent = new Map<string, { received: number; auto: number; escalated: number; confidenceSum: number; confidenceN: number }>()
    for (const r of analytics ?? []) {
      const cur = byAgent.get(r.agent_id as string) ?? { received: 0, auto: 0, escalated: 0, confidenceSum: 0, confidenceN: 0 }
      cur.received   += r.messages_received     ?? 0
      cur.auto       += r.messages_auto_replied ?? 0
      cur.escalated  += r.messages_escalated    ?? 0
      if (r.avg_confidence != null && r.avg_confidence > 0) {
        cur.confidenceSum += r.avg_confidence
        cur.confidenceN++
      }
      byAgent.set(r.agent_id as string, cur)
    }

    return agents.map(a => {
      const v = byAgent.get(a.id as string) ?? { received: 0, auto: 0, escalated: 0, confidenceSum: 0, confidenceN: 0 }
      const autoRate = v.received > 0 ? Math.round((v.auto / v.received) * 100) : 0
      const avgConf  = v.confidenceN > 0 ? Math.round(v.confidenceSum / v.confidenceN) : 0
      return {
        agent_id: a.id, agent_name: a.name, model_id: a.model_id,
        messages: v.received, auto_pct: autoRate, escalated: v.escalated, avg_confidence: avgConf,
      }
    }).sort((a, b) => b.messages - a.messages)
  }

  async listInsights(limit = 10) {
    const { data, error } = await supabaseAdmin
      .from('ai_insights')
      .select('id, type, data, generated_at, expires_at')
      .order('generated_at', { ascending: false })
      .limit(limit)
    if (error) return []
    return data ?? []
  }
}
