import { Injectable } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

@Injectable()
export class ConversationsService {

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
        role: 'human',
        content,
        was_approved_by: userId,
      })
      .select()
      .single()

    if (error) throw error

    await supabaseAdmin
      .from('ai_conversations')
      .update({
        updated_at: new Date().toISOString(),
        total_messages: supabaseAdmin.rpc as unknown as number,
      })
      .eq('id', conversationId)

    // Simpler counter update
    const { data: conv } = await supabaseAdmin
      .from('ai_conversations')
      .select('total_messages')
      .eq('id', conversationId)
      .single()

    await supabaseAdmin
      .from('ai_conversations')
      .update({
        updated_at: new Date().toISOString(),
        total_messages: (conv?.total_messages ?? 0) + 1,
        status: 'waiting_customer',
      })
      .eq('id', conversationId)

    return msg
  }

  async approveSuggestion(conversationId: string, messageId: string, userId: string, editedContent?: string) {
    const update: Record<string, unknown> = {
      was_auto_sent: true,
      was_approved_by: userId,
    }
    if (editedContent) {
      update.content = editedContent
      update.was_edited_before_send = true
    }

    const { data, error } = await supabaseAdmin
      .from('ai_messages')
      .update(update)
      .eq('id', messageId)
      .select()
      .single()

    if (error) throw error
    return data
  }

  async resolve(conversationId: string) {
    const { data, error } = await supabaseAdmin
      .from('ai_conversations')
      .update({
        status: 'resolved',
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
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
        status: 'escalated',
        priority: 'high',
        assigned_to: assignTo ?? null,
        updated_at: new Date().toISOString(),
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
        { onConflict: 'channel,external_conversation_id', ignoreDuplicates: false }
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
        updated_at: new Date().toISOString(),
        total_messages: (conv?.total_messages ?? 0) + 1,
        ...(msg.was_auto_sent ? { auto_replied_count: (conv?.auto_replied_count ?? 0) + 1 } : {}),
        status: msg.was_auto_sent ? 'waiting_customer' : 'waiting_human',
      })
      .eq('id', msg.conversation_id)

    return data
  }
}
