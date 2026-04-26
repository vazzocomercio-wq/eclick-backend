import { Injectable, HttpException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

export interface ChatWidget {
  id:               string
  user_id:          string | null
  name:             string
  agent_id:         string | null
  welcome_message:  string
  placeholder_text: string
  theme_color:      string
  position:         'bottom-right' | 'bottom-left'
  require_name:     boolean
  require_email:    boolean
  require_phone:    boolean
  allowed_origins:  string[]
  is_active:        boolean
  widget_token:     string
  created_at:       string
}

export interface WidgetSession {
  id:                  string
  widget_id:           string
  session_token:       string
  visitor_name:        string | null
  visitor_email:       string | null
  visitor_phone:       string | null
  unified_customer_id: string | null
  conversation_id:     string | null
  origin_url:          string | null
  user_agent:          string | null
  created_at:          string
  last_active_at:      string
}

@Injectable()
export class ChatWidgetService {
  // ── CRUD ──────────────────────────────────────────────────────────────────

  async listForUser(userId: string): Promise<ChatWidget[]> {
    const { data, error } = await supabaseAdmin
      .from('chat_widgets')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    if (error) throw new HttpException(error.message, 500)
    return (data ?? []) as ChatWidget[]
  }

  async create(userId: string, body: Partial<ChatWidget>): Promise<ChatWidget> {
    if (!body.name?.trim()) throw new HttpException('name é obrigatório', 400)
    const { data, error } = await supabaseAdmin
      .from('chat_widgets')
      .insert({
        user_id:          userId,
        name:             body.name,
        agent_id:         body.agent_id         ?? null,
        welcome_message:  body.welcome_message  ?? 'Olá! Como posso ajudar?',
        placeholder_text: body.placeholder_text ?? 'Digite sua mensagem...',
        theme_color:      body.theme_color      ?? '#00E5FF',
        position:         body.position         ?? 'bottom-right',
        require_name:     body.require_name     ?? false,
        require_email:    body.require_email    ?? false,
        require_phone:    body.require_phone    ?? false,
        allowed_origins:  body.allowed_origins  ?? [],
        is_active:        true,
      })
      .select()
      .single()
    if (error) throw new HttpException(error.message, 400)
    return data as ChatWidget
  }

  async update(id: string, body: Partial<ChatWidget>): Promise<ChatWidget> {
    const allowed: Array<keyof ChatWidget> = [
      'name', 'agent_id', 'welcome_message', 'placeholder_text', 'theme_color',
      'position', 'require_name', 'require_email', 'require_phone',
      'allowed_origins', 'is_active',
    ]
    const payload: Record<string, unknown> = {}
    for (const k of allowed) if (body[k] !== undefined) payload[k] = body[k]
    const { data, error } = await supabaseAdmin
      .from('chat_widgets')
      .update(payload)
      .eq('id', id)
      .select()
      .single()
    if (error) throw new HttpException(error.message, 400)
    return data as ChatWidget
  }

  async remove(id: string): Promise<void> {
    const { error } = await supabaseAdmin.from('chat_widgets').delete().eq('id', id)
    if (error) throw new HttpException(error.message, 400)
  }

  // ── Public lookup (used by webhook + widget UI) ───────────────────────────

  async findByToken(token: string): Promise<ChatWidget | null> {
    const { data } = await supabaseAdmin
      .from('chat_widgets')
      .select('*')
      .eq('widget_token', token)
      .eq('is_active', true)
      .maybeSingle()
    return (data as ChatWidget) ?? null
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async getSession(sessionToken: string): Promise<WidgetSession | null> {
    if (!sessionToken) return null
    const { data } = await supabaseAdmin
      .from('widget_sessions')
      .select('*')
      .eq('session_token', sessionToken)
      .maybeSingle()
    return (data as WidgetSession) ?? null
  }

  async createSession(widgetId: string, body: {
    visitor_name?:  string
    visitor_email?: string
    visitor_phone?: string
    origin_url?:    string
    user_agent?:    string
  }): Promise<WidgetSession> {
    const { data, error } = await supabaseAdmin
      .from('widget_sessions')
      .insert({ widget_id: widgetId, ...body })
      .select()
      .single()
    if (error) throw new HttpException(error.message, 400)
    return data as WidgetSession
  }

  async linkCustomerToSession(sessionId: string, customerId: string): Promise<void> {
    await supabaseAdmin
      .from('widget_sessions')
      .update({ unified_customer_id: customerId, last_active_at: new Date().toISOString() })
      .eq('id', sessionId)
  }

  async linkConversationToSession(sessionId: string, conversationId: string): Promise<void> {
    await supabaseAdmin
      .from('widget_sessions')
      .update({ conversation_id: conversationId, last_active_at: new Date().toISOString() })
      .eq('id', sessionId)
  }

  async touchSession(sessionId: string): Promise<void> {
    await supabaseAdmin
      .from('widget_sessions')
      .update({ last_active_at: new Date().toISOString() })
      .eq('id', sessionId)
  }

  // ── Snippet generator (used by /widgets/:id/snippet) ──────────────────────

  buildSnippet(widget: ChatWidget, backendUrl: string): { html: string; widget_token: string; preview_url: string } {
    const html = `<script>
  window.EClickWidget = {
    token: "${widget.widget_token}",
    position: "${widget.position}",
    color: "${widget.theme_color}"
  };
</script>
<script async src="${backendUrl}/widget.js"></script>`
    return {
      html,
      widget_token: widget.widget_token,
      preview_url:  `${backendUrl}/widget-ui/${widget.widget_token}`,
    }
  }

  async getOrThrow(id: string): Promise<ChatWidget> {
    const { data, error } = await supabaseAdmin
      .from('chat_widgets')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) throw new HttpException(error.message, 500)
    if (!data)  throw new NotFoundException('Widget não encontrado')
    return data as ChatWidget
  }
}
