import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { MarketplaceService } from '../marketplace.service'
import { ShopeeAdapter } from '../adapters/shopee.adapter'
import { ShopeeProductSyncService } from '../shopee-sync/shopee-product-sync.service'
import { LlmService } from '../../ai/llm.service'
import type { MpConnection } from '../adapters/base'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

/** Fase B pós-venda — Chat Shopee (sellerchat) no Atendimento.
 *
 *  Polling (cron 5min, gate SHOPEE_CHAT_SYNC='on'): get_conversation_list →
 *  upsert mp_chat_conversations; conversa com novidade → get_message →
 *  upsert mp_chat_messages. Envio de resposta via send_message (texto).
 *
 *  ⛔ BLOQUEIO EXTERNO: o app e-Click hoje recebe `error_api_permission`
 *  nessas rotas — falta a permissão de Chat API no Open Platform Console
 *  (ação do user). O serviço degrada silenciosamente (loga 1 warning por
 *  tick) até a permissão chegar; aí é só setar o env. Shapes com parse
 *  defensivo + log do raw pra calibrar na 1ª chamada real. */
@Injectable()
export class ShopeeChatService {
  private readonly logger = new Logger(ShopeeChatService.name)
  private calibrated = false

  constructor(
    private readonly mp:          MarketplaceService,
    private readonly adapter:     ShopeeAdapter,
    private readonly productSync: ShopeeProductSyncService,
    private readonly llm:         LlmService,
  ) {}

  @Cron('*/5 * * * *', { name: 'shopee-chat-sync' })
  async syncTick(): Promise<void> {
    if (process.env.SHOPEE_CHAT_SYNC !== 'on') return
    const { data: rows } = await supabaseAdmin
      .from('marketplace_connections')
      .select('organization_id')
      .eq('platform', 'shopee')
      .eq('status', 'connected')
    const orgIds = [...new Set((rows ?? []).map(r => r.organization_id as string))]
    for (const orgId of orgIds) {
      try {
        await this.syncChats(orgId)
      } catch (e) {
        this.logger.warn(`[shopee.chat.cron] org=${orgId}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  /** Sincroniza conversas+mensagens de TODAS as lojas Shopee da org. */
  async syncChats(orgId: string): Promise<Array<{ shop_id: number | null; conversations?: number; messages?: number; error?: string }>> {
    const conns = (await this.mp.listConnections(orgId)).filter(c => c.platform === 'shopee')
    if (conns.length === 0) throw new NotFoundException('Nenhuma loja Shopee conectada nesta organização')
    const out = []
    for (const c of conns) {
      try {
        out.push(await this.syncShop(orgId, c))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // permissão ainda não concedida no console — degrada sem stack-spam
        if (msg.includes('error_api_permission')) {
          this.logger.warn(`[shopee.chat] shop=${c.shop_id} sem permissão de Chat API (habilitar no Open Platform Console)`)
        } else {
          this.logger.warn(`[shopee.chat] shop=${c.shop_id} falhou: ${msg}`)
        }
        out.push({ shop_id: c.shop_id ?? null, error: msg })
      }
    }
    return out
  }

  private async syncShop(orgId: string, baseConn: MpConnection): Promise<{ shop_id: number; conversations: number; messages: number }> {
    const conn = await this.productSync.ensureFreshToken(baseConn)
    if (!conn.shop_id) throw new NotFoundException('Conexão Shopee sem shop_id')
    const shopId = conn.shop_id

    const { conversations } = await this.adapter.chatGetConversationList(conn, { pageSize: 50 })
    if (!this.calibrated && conversations[0]) {
      // 1ª chamada real: loga o shape cru pra calibrar o mapeamento
      this.logger.log(`[shopee.chat.calibrate] conversa[0]=${JSON.stringify(conversations[0]).slice(0, 1500)}`)
      this.calibrated = true
    }

    let convCount = 0
    let msgCount = 0
    for (const c of conversations) {
      const extId = c?.conversation_id != null ? String(c.conversation_id) : null
      if (!extId) continue

      // nano → ms (timestamp da última mensagem)
      const lastNano = Number(c?.last_message_timestamp ?? 0)
      const lastAt = lastNano > 0 ? new Date(Math.floor(lastNano / 1e6)).toISOString() : null
      const fromBuyer = c?.latest_message_from_id != null
        ? String(c.latest_message_from_id) !== String(shopId)
        : null

      // upsert da conversa
      const { data: convRow, error: convErr } = await supabaseAdmin
        .from('mp_chat_conversations')
        .upsert(
          {
            organization_id:          orgId,
            platform:                 'shopee',
            shop_id:                  String(shopId),
            external_conversation_id: extId,
            buyer_user_id:            c?.to_id != null ? String(c.to_id) : null,
            buyer_username:           c?.to_name ?? null,
            buyer_avatar:             c?.to_avatar ?? null,
            unread_count:             Number(c?.unread_count ?? 0) || 0,
            last_message_at:          lastAt,
            last_message_preview:     c?.latest_message_content?.text ?? null,
            last_message_from:        fromBuyer == null ? null : fromBuyer ? 'buyer' : 'seller',
            raw:                      c,
            updated_at:               new Date().toISOString(),
          },
          { onConflict: 'organization_id,platform,external_conversation_id' },
        )
        .select('id, last_message_at')
        .maybeSingle()
      if (convErr || !convRow) {
        this.logger.warn(`[shopee.chat] upsert conversa ${extId}: ${convErr?.message}`)
        continue
      }
      convCount++

      // busca mensagens quando a conversa tem novidade (unread ou recente)
      const hasNews = Number(c?.unread_count ?? 0) > 0 || true // 1ª versão: sempre puxa a última página
      if (hasNews) {
        msgCount += await this.syncMessages(orgId, conn, convRow.id as string, extId, shopId)
      }
    }

    this.logger.log(`[shopee.chat] org=${orgId} shop=${shopId} conversas=${convCount} msgs=${msgCount}`)
    return { shop_id: shopId, conversations: convCount, messages: msgCount }
  }

  /** Puxa a página mais recente de mensagens da conversa e upserta. */
  private async syncMessages(orgId: string, conn: MpConnection, convId: string, extConvId: string, shopId: number): Promise<number> {
    const { messages } = await this.adapter.chatGetMessages(conn, extConvId, { pageSize: 30 })
    let n = 0
    let lastOrderSn: string | null = null
    for (const m of messages) {
      const extMsgId = m?.message_id != null ? String(m.message_id) : null
      if (!extMsgId) continue
      const fromSeller = String(m?.from_shop_id ?? m?.from_id ?? '') === String(shopId)
      const { content, mediaUrl, orderSn } = this.extractContent(m)
      if (orderSn) lastOrderSn = orderSn
      const sentMs = Number(m?.created_timestamp ?? 0)
      const { error } = await supabaseAdmin.from('mp_chat_messages').upsert(
        {
          organization_id:     orgId,
          conversation_id:     convId,
          external_message_id: extMsgId,
          direction:           fromSeller ? 'seller' : 'buyer',
          message_type:        m?.message_type ?? null,
          content,
          media_url:           mediaUrl,
          sent_at:             sentMs > 0 ? new Date(sentMs * 1000).toISOString() : null,
          raw:                 m,
        },
        { onConflict: 'organization_id,conversation_id,external_message_id' },
      )
      if (!error) n++
    }
    if (lastOrderSn) {
      await supabaseAdmin
        .from('mp_chat_conversations')
        .update({ last_order_sn: lastOrderSn, updated_at: new Date().toISOString() })
        .eq('id', convId)
    }
    return n
  }

  /** Extrai texto/mídia de uma mensagem do sellerchat (tipos variados). */
  private extractContent(m: Json): { content: string | null; mediaUrl: string | null; orderSn: string | null } {
    const type = m?.message_type ?? 'text'
    const c = m?.content ?? {}
    switch (type) {
      case 'text':    return { content: c.text ?? null, mediaUrl: null, orderSn: null }
      case 'image':   return { content: '[imagem]', mediaUrl: c.url ?? c.image_url ?? null, orderSn: null }
      case 'video':   return { content: '[vídeo]', mediaUrl: c.video_url ?? c.url ?? null, orderSn: null }
      case 'sticker': return { content: '[figurinha]', mediaUrl: null, orderSn: null }
      case 'order':   return { content: c.order_sn ? `[pedido ${c.order_sn}]` : '[pedido]', mediaUrl: null, orderSn: c.order_sn ? String(c.order_sn) : null }
      case 'item':    return { content: c.item_id ? `[produto ${c.item_id}]` : '[produto]', mediaUrl: null, orderSn: null }
      default:        return { content: c.text ?? `[${type}]`, mediaUrl: null, orderSn: null }
    }
  }

  // ── leitura pro front ─────────────────────────────────────────────────────

  async listConversations(orgId: string, opts: { unread?: boolean } = {}): Promise<Json> {
    let q = supabaseAdmin
      .from('mp_chat_conversations')
      .select('*')
      .eq('organization_id', orgId)
      .eq('platform', 'shopee')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(200)
    if (opts.unread) q = q.gt('unread_count', 0)
    const { data, error } = await q
    if (error) throw new Error(error.message)

    const { data: conns } = await supabaseAdmin
      .from('marketplace_connections')
      .select('shop_id, nickname')
      .eq('organization_id', orgId)
      .eq('platform', 'shopee')
    const shops = (conns ?? [])
      .filter(c => c.shop_id != null)
      .map(c => ({ shop_id: String(c.shop_id), nickname: (c.nickname as string) ?? `Shopee #${c.shop_id}` }))

    return { conversations: data ?? [], shops }
  }

  async getConversation(orgId: string, id: string): Promise<Json> {
    const { data: conv, error } = await supabaseAdmin
      .from('mp_chat_conversations')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!conv) throw new NotFoundException('Conversa não encontrada')

    const { data: messages } = await supabaseAdmin
      .from('mp_chat_messages')
      .select('*')
      .eq('organization_id', orgId)
      .eq('conversation_id', id)
      .order('sent_at', { ascending: true })
      .limit(200)

    return { conversation: conv, messages: messages ?? [] }
  }

  // ── envio (⚠️ mensagem real pro comprador) ────────────────────────────────

  async send(orgId: string, conversationId: string, text: string): Promise<Json> {
    const body = (text ?? '').trim()
    if (!body) throw new BadRequestException('Mensagem vazia')
    if (body.length > 1000) throw new BadRequestException('Mensagem longa demais (máx 1000)')

    const { data: conv } = await supabaseAdmin
      .from('mp_chat_conversations')
      .select('id, shop_id, buyer_user_id, external_conversation_id')
      .eq('organization_id', orgId)
      .eq('id', conversationId)
      .maybeSingle()
    if (!conv) throw new NotFoundException('Conversa não encontrada')
    if (!conv.buyer_user_id) throw new BadRequestException('Conversa sem buyer_user_id — re-sincronize o chat')

    const conns = (await this.mp.listConnections(orgId)).filter(c =>
      c.platform === 'shopee' && String(c.shop_id) === String(conv.shop_id))
    if (!conns.length) throw new NotFoundException(`Loja Shopee ${conv.shop_id} não conectada`)
    const conn = await this.productSync.ensureFreshToken(conns[0])

    const resp = await this.adapter.chatSendMessage(conn, conv.buyer_user_id, body)

    // espelha a mensagem enviada (id da resposta quando vier; senão sintético)
    const extMsgId = resp?.message_id != null ? String(resp.message_id) : `local-${Date.now()}`
    await supabaseAdmin.from('mp_chat_messages').upsert(
      {
        organization_id:     orgId,
        conversation_id:     conversationId,
        external_message_id: extMsgId,
        direction:           'seller',
        message_type:        'text',
        content:             body,
        sent_at:             new Date().toISOString(),
        raw:                 resp ?? {},
      },
      { onConflict: 'organization_id,conversation_id,external_message_id' },
    )
    await supabaseAdmin
      .from('mp_chat_conversations')
      .update({
        last_message_preview: body.slice(0, 200),
        last_message_from:    'seller',
        last_message_at:      new Date().toISOString(),
        updated_at:           new Date().toISOString(),
      })
      .eq('id', conversationId)

    return { sent: true, message_id: extMsgId }
  }

  // ── IA: resposta sugerida ─────────────────────────────────────────────────

  async suggest(orgId: string, conversationId: string): Promise<{ text: string }> {
    const detail = await this.getConversation(orgId, conversationId)
    const conv = detail.conversation as Json
    const messages = (detail.messages as Json[]).slice(-12)

    // contexto do pedido (quando o chat referencia um)
    let orderCtx = ''
    if (conv.last_order_sn) {
      const { data: orderRow } = await supabaseAdmin
        .from('orders')
        .select('product_title, status, shipping_status, sale_price, sold_at')
        .eq('organization_id', orgId)
        .eq('source', 'shopee')
        .eq('external_order_id', conv.last_order_sn)
        .limit(1)
        .maybeSingle()
      if (orderRow) {
        orderCtx = `\nPedido relacionado (${conv.last_order_sn}): produto "${orderRow.product_title}", ` +
          `status ${orderRow.status}/${orderRow.shipping_status ?? '—'}, valor R$ ${orderRow.sale_price}, ` +
          `comprado em ${orderRow.sold_at}.`
      }
    }

    // nome da loja
    const { data: connRow } = await supabaseAdmin
      .from('marketplace_connections')
      .select('nickname')
      .eq('organization_id', orgId)
      .eq('platform', 'shopee')
      .eq('shop_id', Number(conv.shop_id))
      .maybeSingle()
    const storeName = (connRow?.nickname as string | undefined) ?? 'a loja'

    const thread = messages
      .map((m: Json) => `${m.direction === 'seller' ? 'VENDEDOR' : 'COMPRADOR'}: ${m.content ?? `[${m.message_type}]`}`)
      .join('\n')

    const out = await this.llm.generateText({
      orgId,
      feature:      'shopee_chat_suggest',
      systemPrompt:
        `Você é atendente da loja "${storeName}" na Shopee Brasil. Responda mensagens de compradores ` +
        `com cordialidade, objetividade e em português do Brasil. Regras: nunca prometa o que não foi ` +
        `confirmado; não compartilhe contatos externos nem links fora da Shopee (violaria as políticas da ` +
        `plataforma); se faltar informação, peça educadamente. Responda APENAS com o texto da mensagem, ` +
        `sem aspas nem prefixos.`,
      userPrompt:
        `Conversa com ${conv.buyer_username ?? 'comprador'}:${orderCtx}\n\n${thread}\n\n` +
        `Escreva a melhor resposta do vendedor pra última mensagem do comprador (máx 600 caracteres).`,
      maxTokens: 400,
    })
    return { text: out.text.trim() }
  }
}
