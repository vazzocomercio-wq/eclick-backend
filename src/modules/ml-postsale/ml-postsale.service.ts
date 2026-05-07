import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import { MlAiCoreService } from '../ml-ai-core/ml-ai-core.service'
import { EventsGateway } from '../events/events.gateway'
import { businessHoursElapsed } from './helpers/business-hours'
import { slaState, type SlaState } from './helpers/sla-state'
import type {
  MlPackMessage,
  MlPackMessagesResponse,
  MlOrderSummary,
  ConversationContextSnapshot,
} from './ml-postsale.types'

const ML_BASE = 'https://api.mercadolibre.com'

interface ConversationRow {
  id:                       string
  organization_id:          string
  seller_id:                number | null
  pack_id:                  string | number
  order_id:                 string | number | null
  buyer_id:                 number
  buyer_nickname:           string | null
  ml_listing_id:            string | null
  product_title:            string | null
  product_thumbnail:        string | null
  status:                   string
  last_buyer_message_at:    string | null
  last_seller_message_at:   string | null
  unread_count:             number
}

/**
 * Núcleo do módulo Pós-venda. Recebe eventos do webhook (topic=messages),
 * sincroniza conversa com a API ML, persiste mensagens, dispara
 * classificação + sugestão pra cada mensagem do comprador, calcula SLA e
 * emite eventos Socket.IO.
 *
 * Modo MVP 1: IA SUGERE, humano aprova e envia. Sem auto-reply.
 */
@Injectable()
export class MlPostsaleService {
  private readonly logger = new Logger(MlPostsaleService.name)

  constructor(
    private readonly ml:     MercadolivreService,
    private readonly aiCore: MlAiCoreService,
    private readonly events: EventsGateway,
  ) {}

  // ════════════════════════════════════════════════════════════════════════
  // ENTRADA — Webhook ML
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Trata um evento webhook ML do tipo messages.
   * resource: "/messages/packs/{pack_id}/sellers/{seller_id}"
   * Strategy: extrai pack_id+seller_id, baixa pack metadata + mensagens,
   * persiste tudo, processa msgs novas do comprador.
   */
  async handleMessageWebhook(orgId: string, resource: string, sellerId: number): Promise<void> {
    const { packId } = parseMessageResource(resource)
    if (!packId) {
      this.logger.warn(`[postsale.webhook] resource sem pack_id: ${resource}`)
      return
    }

    try {
      const conv = await this.upsertConversationFromPack(orgId, packId, sellerId)
      const newMsgs = await this.syncMessagesForConversation(orgId, conv, sellerId)
      if (newMsgs.length > 0) {
        await this.refreshSlaState(conv.id)
        // Emite Socket.IO evento — front faz refetch
        this.events.emitToOrg(orgId, 'ml:postsale:new_message', {
          conversationId: conv.id,
          packId:         conv.pack_id,
          newMessages:    newMsgs.length,
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.warn(`[postsale.webhook] org=${orgId} pack=${packId}: ${msg}`)
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // SYNC — pega dados frescos da API ML e persiste
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Garante que existe row em ml_conversations pra esse pack. Faz fetch do
   * pack + order pra preencher buyer/produto/order metadados.
   */
  private async upsertConversationFromPack(
    orgId: string,
    packId: string,
    sellerId: number,
  ): Promise<ConversationRow> {
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId).catch(() => ({ token: '' }))
    if (!token) throw new NotFoundException(`ML token não encontrado pra org=${orgId} seller=${sellerId}`)

    // Tenta buscar pack metadata. Se falhar (pack ainda não existe na API),
    // cria conversa enxuta com fallback de buyer_id 0.
    let buyerId = 0
    let buyerNick: string | undefined
    let orderId: number | undefined
    let productTitle: string | undefined
    let productThumbnail: string | undefined
    let listingId: string | undefined

    try {
      const { data: pack } = await axios.get(`${ML_BASE}/messages/packs/${packId}/sellers/${sellerId}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15_000,
      })
      buyerId   = pack?.buyer?.id ?? 0
      buyerNick = pack?.buyer?.nickname
      // orderId pode vir em pack.order_id ou pack.order_ids[0]
      const oid = pack?.order_id ?? pack?.order_ids?.[0]?.id
      if (oid) orderId = Number(oid)
    } catch (e) {
      this.logger.warn(`[postsale.upsert] pack metadata falhou pack=${packId}: ${(e as Error).message}`)
    }

    // Se temos order_id, fetch order pra produto + shipping
    if (orderId) {
      try {
        const { data: order } = await axios.get<MlOrderSummary>(`${ML_BASE}/orders/${orderId}`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 15_000,
        })
        const item = order?.order_items?.[0]?.item
        productTitle     = item?.title
        productThumbnail = item?.thumbnail
        listingId        = item?.id
        if (!buyerId)    buyerId   = order?.buyer?.id ?? 0
        if (!buyerNick)  buyerNick = order?.buyer?.nickname
      } catch (e) {
        this.logger.warn(`[postsale.upsert] order ${orderId} fetch falhou: ${(e as Error).message}`)
      }
    }

    // Upsert conversation
    const payload = {
      organization_id:    orgId,
      seller_id:          sellerId,
      pack_id:            Number(packId),
      order_id:           orderId ?? null,
      buyer_id:           buyerId,
      buyer_nickname:     buyerNick ?? null,
      ml_listing_id:      listingId ?? null,
      product_title:      productTitle ?? null,
      product_thumbnail:  productThumbnail ?? null,
    }
    const { data: row, error } = await supabaseAdmin
      .from('ml_conversations')
      .upsert(payload, { onConflict: 'organization_id,pack_id' })
      .select('*')
      .single()
    if (error || !row) {
      throw new BadRequestException(`Falha ao upsert conversation: ${error?.message ?? 'desconhecido'}`)
    }
    return row as ConversationRow
  }

  /**
   * Baixa mensagens novas do pack e persiste. Para cada nova msg do
   * comprador, dispara classify+suggest. Devolve array das msgs persistidas.
   */
  private async syncMessagesForConversation(
    orgId: string,
    conv: ConversationRow,
    sellerId: number,
  ): Promise<MlPackMessage[]> {
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)

    // Fetch últimas 50 mensagens. Se houver mais do que isso de gap (raro),
    // perdemos o histórico — aceitável no MVP 1.
    let response: MlPackMessagesResponse
    try {
      const { data } = await axios.get<MlPackMessagesResponse>(
        `${ML_BASE}/messages/packs/${conv.pack_id}/sellers/${sellerId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params:  { limit: 50, mark_as_read: false },
          timeout: 20_000,
        },
      )
      response = data
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status
      if (status === 404) return []
      throw e
    }

    const msgs = response.messages ?? []
    if (msgs.length === 0) return []

    // Quais já temos?
    const ids = msgs.map(m => m.id)
    const { data: existingRows } = await supabaseAdmin
      .from('ml_messages')
      .select('ml_message_id')
      .eq('conversation_id', conv.id)
      .in('ml_message_id', ids)
    const existing = new Set(((existingRows ?? []) as Array<{ ml_message_id: string }>).map(r => r.ml_message_id))

    const toInsert = msgs.filter(m => !existing.has(m.id))
    if (toInsert.length === 0) return []

    const persistRows = toInsert.map(m => ({
      conversation_id:   conv.id,
      ml_message_id:     m.id,
      direction:         m.from?.user_id === sellerId ? 'seller' : 'buyer',
      text:              m.text ?? '',
      attachments:       m.message_attachments ?? [],
      sent_at:           m.message_date?.created   ?? m.message_date?.received ?? new Date().toISOString(),
      received_at:       m.message_date?.received  ?? null,
      read_at:           m.message_date?.read      ?? null,
      moderation_status: m.message_moderation?.status ?? null,
      raw:               m as unknown as Record<string, unknown>,
    }))

    const { data: inserted, error } = await supabaseAdmin
      .from('ml_messages')
      .insert(persistRows)
      .select('id, direction, sent_at, ml_message_id, text')
    if (error) {
      this.logger.warn(`[postsale.sync] insert messages falhou: ${error.message}`)
      return []
    }
    const insertedRows = (inserted ?? []) as Array<{ id: string; direction: string; sent_at: string; ml_message_id: string; text: string }>

    // Atualiza last_*_message_at + unread_count
    await this.touchConversationTimestamps(conv.id)

    // Pra cada nova msg do COMPRADOR, dispara classify+suggest
    const buyerNew = insertedRows.filter(r => r.direction === 'buyer')
    for (const buyerMsg of buyerNew) {
      try {
        await this.classifyAndSuggestForMessage(orgId, conv, buyerMsg.id, buyerMsg.text)
      } catch (e) {
        this.logger.warn(`[postsale.sync] classify+suggest falhou msg=${buyerMsg.id}: ${(e as Error).message}`)
      }
    }

    return toInsert
  }

  private async touchConversationTimestamps(conversationId: string): Promise<void> {
    // Recalcula last_*_message_at + unread_count via SQL (1 round-trip)
    try {
      const { error } = await supabaseAdmin.rpc('_admin_exec_sql', {
        sql: `
          UPDATE ml_conversations c
          SET
            last_buyer_message_at = COALESCE(
              (SELECT MAX(sent_at) FROM ml_messages WHERE conversation_id = c.id AND direction = 'buyer'),
              c.last_buyer_message_at
            ),
            last_seller_message_at = COALESCE(
              (SELECT MAX(sent_at) FROM ml_messages WHERE conversation_id = c.id AND direction = 'seller'),
              c.last_seller_message_at
            ),
            last_message_at = COALESCE(
              (SELECT MAX(sent_at) FROM ml_messages WHERE conversation_id = c.id),
              c.last_message_at
            ),
            unread_count = (
              SELECT COUNT(*) FROM ml_messages
              WHERE conversation_id = c.id
                AND direction = 'buyer'
                AND read_at IS NULL
            )
          WHERE c.id = '${conversationId}';
        `,
      })
      if (error) throw error
    } catch (e) {
      this.logger.warn(`[postsale] touchTimestamps falhou conv=${conversationId}: ${(e as Error).message}`)
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // IA — classifica + sugere por mensagem
  // ════════════════════════════════════════════════════════════════════════

  private async classifyAndSuggestForMessage(
    orgId: string,
    conv: ConversationRow,
    messageId: string,
    text: string,
  ): Promise<void> {
    if (!text?.trim()) return

    const ctx = await this.buildContextSnapshot(orgId, conv)

    // CLASSIFY
    let classification: Awaited<ReturnType<MlAiCoreService['classify']>>
    try {
      classification = await this.aiCore.classify(orgId, text, {
        productTitle:   ctx.productTitle,
        shippingStatus: ctx.shippingStatus,
        buyerNickname:  conv.buyer_nickname ?? undefined,
      })
    } catch (e) {
      this.logger.warn(`[postsale.classify] msg=${messageId} falhou: ${(e as Error).message}`)
      return
    }

    // SUGGEST
    const knowledge = await this.fetchProductKnowledge(orgId, ctx.productTitle, conv.ml_listing_id)
    const history   = await this.fetchRecentHistory(conv.id, 6)

    let suggestion: Awaited<ReturnType<MlAiCoreService['suggestPostsale']>> | null = null
    try {
      suggestion = await this.aiCore.suggestPostsale(orgId, {
        productTitle:        ctx.productTitle,
        shippingStatus:      ctx.shippingStatus,
        estimatedDelivery:   ctx.estimatedDelivery,
        orderTotal:          ctx.orderTotal,
        knowledge,
        conversationHistory: history,
        lastBuyerMessage:    text,
      })
    } catch (e) {
      this.logger.warn(`[postsale.suggest] msg=${messageId} falhou: ${(e as Error).message}`)
    }

    await supabaseAdmin.from('ml_ai_suggestions').insert({
      message_id:         messageId,
      conversation_id:    conv.id,
      organization_id:    orgId,
      intent:             classification.intent,
      sentiment:          classification.sentiment,
      urgency:            classification.urgency,
      risk:               classification.risk,
      can_auto_reply:     false,
      suggested_text:     suggestion?.text ?? null,
      suggested_chars:    suggestion?.charCount ?? null,
      llm_provider:       suggestion?.llm.provider ?? classification.llm.provider,
      llm_model:          suggestion?.llm.model    ?? classification.llm.model,
      llm_input_tokens:   (suggestion?.llm.inputTokens  ?? 0) + classification.llm.inputTokens,
      llm_output_tokens:  (suggestion?.llm.outputTokens ?? 0) + classification.llm.outputTokens,
      llm_cost_usd:       (suggestion?.llm.costUsd ?? 0) + classification.llm.costUsd,
      llm_latency_ms:     (suggestion?.llm.latencyMs ?? 0) + classification.llm.latencyMs,
      llm_fallback_used:  Boolean(suggestion?.llm.fallbackUsed || classification.llm.fallbackUsed),
      action:             'pending',
    })

    // Emite evento que sugestão tá pronta
    this.events.emitToOrg(orgId, 'ml:postsale:suggestion_ready', {
      conversationId: conv.id,
      messageId,
      intent:         classification.intent,
      risk:           classification.risk,
    })
  }

  private async buildContextSnapshot(orgId: string, conv: ConversationRow): Promise<ConversationContextSnapshot> {
    let shippingStatus: string | undefined
    let estimatedDelivery: string | undefined
    let orderTotal: number | undefined

    if (conv.order_id) {
      const { data: order } = await supabaseAdmin
        .from('ml_orders')
        .select('shipping_status, shipping_estimated_delivery, total_amount')
        .eq('organization_id', orgId)
        .eq('order_id', conv.order_id)
        .maybeSingle()
      const orderRow = order as
        | { shipping_status?: string; shipping_estimated_delivery?: string; total_amount?: number }
        | null
      if (orderRow) {
        shippingStatus    = orderRow.shipping_status
        estimatedDelivery = orderRow.shipping_estimated_delivery
        orderTotal        = orderRow.total_amount
      }
    }

    return {
      conversationId:    conv.id,
      organizationId:    orgId,
      packId:            Number(conv.pack_id),
      orderId:           conv.order_id ? Number(conv.order_id) : undefined,
      buyerNickname:     conv.buyer_nickname ?? undefined,
      productTitle:      conv.product_title ?? undefined,
      productThumbnail:  conv.product_thumbnail ?? undefined,
      shippingStatus,
      estimatedDelivery,
      orderTotal,
    }
  }

  private async fetchProductKnowledge(
    orgId: string,
    _productTitle: string | undefined,
    listingId: string | null,
  ): Promise<string | undefined> {
    if (!listingId) return undefined
    const { data } = await supabaseAdmin
      .from('ml_product_knowledge')
      .select('manual, problemas_comuns, garantia, politica_troca, observacoes')
      .eq('organization_id', orgId)
      .eq('ml_listing_id', listingId)
      .maybeSingle()
    if (!data) return undefined
    const k = data as Record<string, string | null>
    const lines: string[] = []
    if (k.manual)            lines.push(`Manual/uso: ${k.manual}`)
    if (k.problemas_comuns)  lines.push(`Problemas comuns: ${k.problemas_comuns}`)
    if (k.garantia)          lines.push(`Garantia: ${k.garantia}`)
    if (k.politica_troca)    lines.push(`Política de troca: ${k.politica_troca}`)
    if (k.observacoes)       lines.push(`Observações: ${k.observacoes}`)
    return lines.length > 0 ? lines.join('\n') : undefined
  }

  private async fetchRecentHistory(
    conversationId: string,
    limit: number,
  ): Promise<Array<{ direction: 'buyer' | 'seller'; text: string }>> {
    const { data } = await supabaseAdmin
      .from('ml_messages')
      .select('direction, text, sent_at')
      .eq('conversation_id', conversationId)
      .order('sent_at', { ascending: false })
      .limit(limit + 1) // +1 pra excluir a msg atual depois se quiser
    const rows = (data ?? []) as Array<{ direction: string; text: string }>
    return rows
      .reverse()
      .filter(r => r.direction === 'buyer' || r.direction === 'seller')
      .map(r => ({ direction: r.direction as 'buyer' | 'seller', text: r.text }))
  }

  // ════════════════════════════════════════════════════════════════════════
  // LISTAGEM E DETALHE — consumidos pelo controller
  // ════════════════════════════════════════════════════════════════════════

  async listConversations(orgId: string, filters: {
    status?:  string
    unread?:  boolean
    sla?:     SlaState
    search?:  string
    limit?:   number
  } = {}): Promise<Array<Record<string, unknown>>> {
    let q = supabaseAdmin
      .from('ml_conversations')
      .select('id, pack_id, order_id, buyer_nickname, product_title, product_thumbnail, status, last_buyer_message_at, last_seller_message_at, unread_count')
      .eq('organization_id', orgId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(filters.limit ?? 100)
    if (filters.status) q = q.eq('status', filters.status)
    if (filters.unread) q = q.gt('unread_count', 0)
    if (filters.search) q = q.or(`buyer_nickname.ilike.*${filters.search}*,product_title.ilike.*${filters.search}*`)
    const { data, error } = await q
    if (error) throw new BadRequestException(error.message)
    const rows = (data ?? []) as Array<Record<string, unknown>>

    // Anexa SLA atual de cada (1 query batch)
    if (rows.length > 0) {
      const ids = rows.map(r => r.id as string)
      const { data: slaRows } = await supabaseAdmin
        .from('ml_sla_events')
        .select('conversation_id, state, business_hours_elapsed, computed_at')
        .in('conversation_id', ids)
        .order('computed_at', { ascending: false })
      const latest = new Map<string, { state: string; elapsed: number }>()
      for (const r of (slaRows ?? []) as Array<{ conversation_id: string; state: string; business_hours_elapsed: number }>) {
        if (!latest.has(r.conversation_id)) {
          latest.set(r.conversation_id, { state: r.state, elapsed: r.business_hours_elapsed })
        }
      }
      for (const row of rows) {
        const sla = latest.get(row.id as string)
        row.sla_state           = sla?.state   ?? 'green'
        row.sla_elapsed_hours   = sla?.elapsed ?? 0
      }
    }

    // Filtra por sla se passou
    return filters.sla
      ? rows.filter(r => r.sla_state === filters.sla)
      : rows
  }

  async getConversationDetail(orgId: string, conversationId: string): Promise<{
    conversation:  Record<string, unknown>
    messages:      Array<Record<string, unknown>>
    suggestion:    Record<string, unknown> | null
    knowledge:     Record<string, unknown> | null
  }> {
    const { data: conv, error } = await supabaseAdmin
      .from('ml_conversations')
      .select('*')
      .eq('id', conversationId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) throw new BadRequestException(error.message)
    if (!conv) throw new NotFoundException(`Conversation ${conversationId} não encontrada`)

    const { data: messages } = await supabaseAdmin
      .from('ml_messages')
      .select('id, ml_message_id, direction, text, attachments, sent_at, read_at, moderation_status')
      .eq('conversation_id', conversationId)
      .order('sent_at', { ascending: true })

    // Sugestão pendente da última mensagem do comprador
    const lastBuyerMsg = ((messages ?? []) as Array<{ direction: string; id: string }>)
      .filter(m => m.direction === 'buyer')
      .pop()
    let suggestion: Record<string, unknown> | null = null
    if (lastBuyerMsg) {
      const { data: sug } = await supabaseAdmin
        .from('ml_ai_suggestions')
        .select('*')
        .eq('message_id', lastBuyerMsg.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      suggestion = (sug as Record<string, unknown> | null)
    }

    // Knowledge do produto
    const c = conv as { ml_listing_id: string | null }
    let knowledge: Record<string, unknown> | null = null
    if (c.ml_listing_id) {
      const { data: kb } = await supabaseAdmin
        .from('ml_product_knowledge')
        .select('*')
        .eq('organization_id', orgId)
        .eq('ml_listing_id', c.ml_listing_id)
        .maybeSingle()
      knowledge = (kb as Record<string, unknown> | null)
    }

    return {
      conversation: conv as Record<string, unknown>,
      messages:     (messages ?? []) as Array<Record<string, unknown>>,
      suggestion,
      knowledge,
    }
  }

  /** Força nova sugestão na última mensagem do comprador. */
  async regenerateSuggestion(orgId: string, conversationId: string): Promise<{ ok: true; suggestion_id?: string }> {
    const detail = await this.getConversationDetail(orgId, conversationId)
    const lastBuyer = (detail.messages as Array<{ id: string; direction: string; text: string }>)
      .filter(m => m.direction === 'buyer')
      .pop()
    if (!lastBuyer) throw new BadRequestException('Sem mensagem do comprador pra sugerir resposta')

    const { data: convRow } = await supabaseAdmin
      .from('ml_conversations')
      .select('id, organization_id, seller_id, pack_id, order_id, buyer_id, buyer_nickname, ml_listing_id, product_title, product_thumbnail, status, last_buyer_message_at, last_seller_message_at, unread_count')
      .eq('id', conversationId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!convRow) throw new NotFoundException()

    await this.classifyAndSuggestForMessage(orgId, convRow as ConversationRow, lastBuyer.id, lastBuyer.text)

    const { data: latest } = await supabaseAdmin
      .from('ml_ai_suggestions')
      .select('id')
      .eq('message_id', lastBuyer.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return { ok: true, suggestion_id: (latest as { id?: string } | null)?.id }
  }

  /** Aplica transformação de tom sobre texto editado. */
  async transformTone(orgId: string, text: string, tone: 'mais_empatico' | 'mais_objetivo'): Promise<{ text: string; charCount: number }> {
    const out = await this.aiCore.transformTone(orgId, text, tone)
    return { text: out.text, charCount: out.charCount }
  }

  /** Resumo SLA do dashboard. */
  async slaDashboard(orgId: string): Promise<{
    counts:       Record<SlaState, number>
    most_critical: Array<Record<string, unknown>>
  }> {
    const conversations = await this.listConversations(orgId, { limit: 500 })
    const counts: Record<SlaState, number> = { green: 0, yellow: 0, orange: 0, red: 0, critical: 0, resolved: 0 }
    for (const c of conversations) {
      const state = (c.sla_state as SlaState) ?? 'green'
      counts[state]++
    }
    const mostCritical = conversations
      .filter(c => c.sla_state === 'critical' || c.sla_state === 'red')
      .slice(0, 10)
    return { counts, most_critical: mostCritical }
  }

  // ════════════════════════════════════════════════════════════════════════
  // KNOWLEDGE BASE — texto livre por produto
  // ════════════════════════════════════════════════════════════════════════

  async getKnowledgeByProductId(orgId: string, productId: string): Promise<Record<string, unknown> | null> {
    const { data } = await supabaseAdmin
      .from('ml_product_knowledge')
      .select('*')
      .eq('organization_id', orgId)
      .eq('product_id', productId)
      .maybeSingle()
    return (data as Record<string, unknown> | null)
  }

  async upsertKnowledge(orgId: string, productId: string, kb: {
    manual?:           string
    problemas_comuns?: string
    garantia?:         string
    politica_troca?:   string
    observacoes?:      string
    updated_by?:       string
  }): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('ml_product_knowledge')
      .upsert({
        organization_id:  orgId,
        product_id:       productId,
        manual:           kb.manual           ?? null,
        problemas_comuns: kb.problemas_comuns ?? null,
        garantia:         kb.garantia         ?? null,
        politica_troca:   kb.politica_troca   ?? null,
        observacoes:      kb.observacoes      ?? null,
        updated_by:       kb.updated_by       ?? null,
      }, { onConflict: 'organization_id,product_id' })
    if (error) throw new BadRequestException(error.message)
    return { ok: true }
  }

  // ════════════════════════════════════════════════════════════════════════
  // ENVIO — humano aprovou e mandou
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Envia mensagem do vendedor pra ML, persiste em ml_messages, atualiza
   * sugestão (se passou suggestion_id) e marca conversation como respondida.
   * Validação 350 chars antes de qualquer call.
   */
  async sendMessage(
    orgId: string,
    conversationId: string,
    args: {
      text:           string
      suggestionId?:  string
      action?:        'sent_as_is' | 'sent_edited'
      actedBy?:       string
    },
  ): Promise<{ ok: true; ml_message_id?: string }> {
    const text = (args.text ?? '').trim()
    if (!text) throw new BadRequestException('text obrigatório')
    if (text.length > 350) {
      throw new BadRequestException(`Texto excede 350 caracteres (${text.length}). Encurte antes de enviar.`)
    }

    const { data: conv } = await supabaseAdmin
      .from('ml_conversations')
      .select('id, organization_id, pack_id, seller_id, buyer_id')
      .eq('id', conversationId)
      .eq('organization_id', orgId)
      .maybeSingle()
    const c = conv as
      | { id: string; organization_id: string; pack_id: string | number; seller_id: number | null; buyer_id: number }
      | null
    if (!c) throw new NotFoundException(`Conversation ${conversationId} não encontrada`)
    if (!c.seller_id) throw new BadRequestException(`Conversation ${conversationId} sem seller_id — sincronize primeiro`)

    const { token } = await this.ml.getTokenForOrg(orgId, c.seller_id)

    // POST /messages/packs/{pack_id}/sellers/{seller_id}
    let mlMessageId: string | undefined
    try {
      const { data } = await axios.post(
        `${ML_BASE}/messages/packs/${c.pack_id}/sellers/${c.seller_id}`,
        {
          from: { user_id: c.seller_id },
          to:   { user_id: c.buyer_id  },
          text,
        },
        {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          timeout: 20_000,
        },
      )
      mlMessageId = (data as { id?: string })?.id
    } catch (e) {
      const status = (e as { response?: { status?: number; data?: unknown } })?.response?.status
      const body   = (e as { response?: { data?: unknown } })?.response?.data
      this.logger.warn(`[postsale.send] org=${orgId} conv=${conversationId} status=${status} body=${JSON.stringify(body)}`)
      throw new BadRequestException(`ML rejeitou envio: HTTP ${status ?? 'unknown'}`)
    }

    // Persiste como nossa msg outbound (caso webhook venha depois, dedupe via UNIQUE)
    if (mlMessageId) {
      try {
        await supabaseAdmin.from('ml_messages').insert({
          conversation_id: conversationId,
          ml_message_id:   mlMessageId,
          direction:       'seller',
          text,
          attachments:     [],
          sent_at:         new Date().toISOString(),
          raw:             { sent_via: 'eclick-postsale' },
        })
      } catch {
        // Insert pode falhar por UNIQUE — webhook chegou primeiro. OK.
      }
    }

    // Atualiza sugestão (se houve)
    if (args.suggestionId) {
      await supabaseAdmin
        .from('ml_ai_suggestions')
        .update({
          action:     args.action ?? 'sent_edited',
          final_text: text,
          acted_by:   args.actedBy ?? null,
          acted_at:   new Date().toISOString(),
        })
        .eq('id', args.suggestionId)
        .eq('organization_id', orgId)
    }

    await this.touchConversationTimestamps(conversationId)
    await this.refreshSlaState(conversationId)

    return { ok: true, ml_message_id: mlMessageId }
  }

  /**
   * Marca conversa como resolvida manualmente. Não envia nada pra ML —
   * é só estado interno.
   */
  async markResolved(orgId: string, conversationId: string, actedBy?: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('ml_conversations')
      .update({
        status:      'resolved',
        resolved_at: new Date().toISOString(),
        resolved_by: actedBy ?? null,
      })
      .eq('id', conversationId)
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)
    await this.refreshSlaState(conversationId)
    return { ok: true }
  }

  // ════════════════════════════════════════════════════════════════════════
  // SLA
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Recalcula estado SLA de UMA conversa e grava em ml_sla_events.
   */
  async refreshSlaState(conversationId: string): Promise<{ state: SlaState; elapsed: number } | null> {
    const { data: conv } = await supabaseAdmin
      .from('ml_conversations')
      .select('id, organization_id, status, last_buyer_message_at, last_seller_message_at, resolved_at')
      .eq('id', conversationId)
      .maybeSingle()
    const c = conv as
      | { id: string; organization_id: string; status: string; last_buyer_message_at: string | null; last_seller_message_at: string | null; resolved_at: string | null }
      | null
    if (!c) return null

    if (!c.last_buyer_message_at) return null // nada pra contar

    const lastBuyer  = new Date(c.last_buyer_message_at)
    const lastSeller = c.last_seller_message_at ? new Date(c.last_seller_message_at) : null
    const hasResponse = !!(lastSeller && lastSeller.getTime() >= lastBuyer.getTime()) || !!c.resolved_at

    const elapsed = hasResponse ? 0 : businessHoursElapsed(lastBuyer)
    const state   = slaState(elapsed, hasResponse)

    // Pega último estado pra evitar inserir duplicado idêntico
    const { data: lastEvent } = await supabaseAdmin
      .from('ml_sla_events')
      .select('state')
      .eq('conversation_id', conversationId)
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const lastState = (lastEvent as { state?: string } | null)?.state

    if (lastState !== state) {
      await supabaseAdmin.from('ml_sla_events').insert({
        conversation_id:        conversationId,
        organization_id:        c.organization_id,
        state,
        business_hours_elapsed: elapsed,
      })

      this.events.emitToOrg(c.organization_id, 'ml:postsale:sla_changed', {
        conversationId,
        state,
        elapsed,
      })
    }

    return { state, elapsed }
  }

  /**
   * Recalcula SLA de TODAS as conversas em estado pendente. Chamado pelo cron.
   */
  async recomputeAllSlaStates(): Promise<{ checked: number; transitions: number }> {
    const { data } = await supabaseAdmin
      .from('ml_conversations')
      .select('id')
      .not('last_buyer_message_at', 'is', null)
      .neq('status', 'resolved')

    const rows = (data ?? []) as Array<{ id: string }>
    let transitions = 0
    for (const r of rows) {
      try {
        const before = await this.lastSlaState(r.id)
        const after  = await this.refreshSlaState(r.id)
        if (after && before !== after.state) transitions++
      } catch (e) {
        this.logger.warn(`[postsale.recompute] ${r.id} falhou: ${(e as Error).message}`)
      }
    }
    return { checked: rows.length, transitions }
  }

  private async lastSlaState(conversationId: string): Promise<string | null> {
    const { data } = await supabaseAdmin
      .from('ml_sla_events')
      .select('state')
      .eq('conversation_id', conversationId)
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data as { state?: string } | null)?.state ?? null
  }
}

// ════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════

function parseMessageResource(resource: string): { packId?: string; sellerId?: string } {
  // /messages/packs/123/sellers/2290161131
  const m = resource.match(/\/messages\/packs\/([^/]+)\/sellers\/([^/]+)/)
  if (!m) return {}
  return { packId: m[1], sellerId: m[2] }
}
