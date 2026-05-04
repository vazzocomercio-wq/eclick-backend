import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  type WASocket,
  type WAMessage,
  type WAMessageContent,
  type ConnectionState,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import { getSupabase } from '../supabase.js'
import { broadcastRealtime } from './internal-api-client.js'
import { loadAuthState, type BaileysAuthHandle } from './baileys-auth-state.js'

interface SessionContext {
  channelId: string
  orgId: string
  /** True quando a sessão NÃO tem auth state ainda (precisa pareamento via QR) */
  needsPairing: boolean
}

/**
 * Gerencia uma sessão Baileys (= 1 socket WhatsApp Web pra um canal).
 * Encapsula:
 *   - Boot (carrega auth state, conecta)
 *   - Eventos: connection.update (QR/connected/disconnected), creds.update
 *     (auto-save), messages.upsert (broadcast para frontend)
 *   - Reconnect transient
 *   - Cleanup explícito
 *
 * NOTA SaaS: ao contrário do Active, NÃO persistimos contacts/conversations/
 * messages no DB — o SaaS ainda não tem CRM. Inbound messages são logadas
 * e broadcast pro frontend via `message:new`. Persistência fica como TODO
 * pra quando o módulo CRM existir.
 */
const JID_CACHE_TTL_MS = 24 * 3600 * 1000  // 24h
const JID_CACHE_NEGATIVE_TTL_MS = 30 * 60 * 1000  // 30min pra exists=false (evita re-tentar errado por dia inteiro)

export class BaileysSession {
  private sock: WASocket | null = null
  private auth: BaileysAuthHandle | null = null
  private currentQr: string | null = null
  private connecting = false
  private terminated = false

  /**
   * Cache phone limpo → JID canônico (com TTL).
   * Resolve o problema dos celulares brasileiros pré-2012 cujo JID no
   * WhatsApp NÃO tem o nono dígito (cadastro pré-reforma de 2012).
   * Sem cache, cada sendMessage faria um onWhatsApp() que custa ~200ms.
   *
   * Entry com `jid=null` indica número sem WhatsApp (TTL menor).
   */
  private readonly jidCache = new Map<string, { jid: string | null; expiresAt: number }>()

  private readonly logger = pino({
    level: process.env.BAILEYS_LOG_LEVEL ?? 'warn',
    base: { sess: 'baileys' },
  })

  constructor(private readonly ctx: SessionContext) {}

  get channelId(): string {
    return this.ctx.channelId
  }

  get orgId(): string {
    return this.ctx.orgId
  }

  get qr(): string | null {
    return this.currentQr
  }

  async start(): Promise<void> {
    if (this.connecting || this.terminated) return
    this.connecting = true

    try {
      this.auth = await loadAuthState(this.ctx.channelId)
      const { version } = await fetchLatestBaileysVersion()

      this.sock = makeWASocket({
        version,
        auth: this.auth.state,
        printQRInTerminal: false,
        browser: Browsers.appropriate('e-Click SaaS'),
        logger: this.logger as never,
        syncFullHistory: false,
        markOnlineOnConnect: false,
      })

      this.sock.ev.on('creds.update', () => {
        void this.auth?.saveCreds()
      })

      this.sock.ev.on('connection.update', (update) => {
        void this.onConnectionUpdate(update).catch((err) => {
          // eslint-disable-next-line no-console
          console.error(`[baileys ${this.ctx.channelId}] connection.update erro:`, err)
        })
      })

      this.sock.ev.on('messages.upsert', (m) => {
        if (m.type !== 'notify') return
        for (const msg of m.messages) {
          void this.handleInbound(msg).catch((err) => {
            // eslint-disable-next-line no-console
            console.error(`[baileys ${this.ctx.channelId}] handleInbound erro:`, err)
          })
        }
      })
    } finally {
      this.connecting = false
    }
  }

  async stop(): Promise<void> {
    this.terminated = true
    this.sock?.end(undefined)
    this.sock = null
  }

  // ──────────────────────────────────────────────────────────
  // OUTBOUND
  // ──────────────────────────────────────────────────────────

  /**
   * Envia mensagem via Baileys WebSocket. Lança erros tipados:
   *   - `session_not_ready`: socket ainda não abriu
   *   - `session_terminated`: sessão encerrada
   *   - `send_failed`: Baileys não retornou messageId
   */
  async sendMessage(phone: string, content: OutboundContent): Promise<string> {
    if (!this.sock) {
      throw new Error('session_not_ready: socket Baileys ainda não conectado')
    }
    if (this.terminated) {
      throw new Error('session_terminated: sessão encerrada')
    }

    const jid = await this.resolveJid(phone)

    let payload: Parameters<WASocket['sendMessage']>[1]
    switch (content.kind) {
      case 'text':
        payload = { text: content.body }
        break
      case 'image':
        payload = {
          image: { url: content.url },
          ...(content.caption ? { caption: content.caption } : {}),
        }
        break
      case 'audio':
        payload = {
          audio: { url: content.url },
          mimetype: content.mime_type ?? 'audio/ogg; codecs=opus',
          ptt: content.ptt ?? true,
        }
        break
      case 'video':
        payload = {
          video: { url: content.url },
          ...(content.caption ? { caption: content.caption } : {}),
        }
        break
      case 'document':
        payload = {
          document: { url: content.url },
          mimetype: content.mime_type ?? 'application/octet-stream',
          ...(content.filename ? { fileName: content.filename } : {}),
        }
        break
      default: {
        const _exhaustive: never = content
        throw new Error(`unsupported_content: ${(_exhaustive as { kind: string }).kind}`)
      }
    }

    const result = await this.sock.sendMessage(jid, payload)
    if (!result?.key?.id) {
      throw new Error('send_failed: Baileys não retornou messageId')
    }
    return result.key.id
  }

  isReady(): boolean {
    return !!this.sock && !this.terminated
  }

  /**
   * Resolve `phone` (dígitos puros) ou JID puro pro JID canônico do WhatsApp,
   * com cache em memória. Lança erro tipado se número não tem WhatsApp —
   * caller decide se silencia ou propaga.
   *
   * Erros possíveis:
   *   - `number_not_on_whatsapp`: onWhatsApp retornou exists=false
   *   - `session_not_ready`: socket não conectado
   */
  private async resolveJid(phoneOrJid: string): Promise<string> {
    if (phoneOrJid.includes('@')) return phoneOrJid

    const cleaned = phoneOrJid.replace(/\D/g, '')
    if (!cleaned) throw new Error('invalid_phone: empty after cleaning')

    const cached = this.jidCache.get(cleaned)
    if (cached && cached.expiresAt > Date.now()) {
      if (!cached.jid) throw new Error(`number_not_on_whatsapp: ${cleaned}`)
      return cached.jid
    }

    if (!this.sock) throw new Error('session_not_ready: socket Baileys ainda não conectado')

    const results = await this.sock.onWhatsApp(cleaned).catch(() => [])
    const first = results?.[0]

    if (!first?.exists || !first.jid) {
      // Cache negativo curto pra evitar lookup pesado em loop
      this.jidCache.set(cleaned, { jid: null, expiresAt: Date.now() + JID_CACHE_NEGATIVE_TTL_MS })
      throw new Error(`number_not_on_whatsapp: ${cleaned}`)
    }

    this.jidCache.set(cleaned, { jid: first.jid, expiresAt: Date.now() + JID_CACHE_TTL_MS })

    // Log apenas quando há normalização (caso pré-2012) — sinaliza pro
    // operador que o number_input não bate com o JID real.
    const jidPhone = first.jid.replace('@s.whatsapp.net', '')
    if (jidPhone !== cleaned) {
      // eslint-disable-next-line no-console
      console.log(
        `[baileys ${this.ctx.channelId}] JID normalize ${cleaned} → ${jidPhone} (legacy WA registration)`,
      )
    }

    return first.jid
  }

  /**
   * Pergunta ao Baileys se um número tem WhatsApp ativo. Aceita telefone
   * em formato internacional (5571999999999) ou JID. Retorna o JID
   * canônico, foto de perfil e profile name (best-effort).
   */
  async checkNumber(phoneOrJid: string): Promise<{
    exists: boolean
    jid?: string
    profile_name?: string
    profile_pic_url?: string
  }> {
    if (!this.sock || this.terminated) {
      throw new Error('session_not_ready')
    }
    const cleaned = phoneOrJid.includes('@')
      ? phoneOrJid
      : phoneOrJid.replace(/\D/g, '')
    if (!cleaned) return { exists: false }

    const results = await this.sock.onWhatsApp(cleaned).catch(() => [])
    const first = results?.[0]
    if (!first?.exists || !first.jid) {
      return { exists: false }
    }

    const profilePicUrl = await this.sock
      .profilePictureUrl(first.jid, 'image')
      .catch(() => undefined)

    let profileName: string | undefined
    try {
      const stored = (
        this.sock as unknown as {
          store?: { contacts?: Record<string, { name?: string; notify?: string }> }
        }
      ).store?.contacts?.[first.jid]
      if (stored?.name) profileName = stored.name
      else if (stored?.notify) profileName = stored.notify
    } catch {
      /* sem store, sem nome */
    }

    return {
      exists: true,
      jid: first.jid,
      ...(profileName ? { profile_name: profileName } : {}),
      ...(profilePicUrl ? { profile_pic_url: profilePicUrl } : {}),
    }
  }

  // ──────────────────────────────────────────────────────────
  // Event handlers
  // ──────────────────────────────────────────────────────────

  private async onConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      this.currentQr = qr
      void broadcastRealtime({
        org_id: this.ctx.orgId,
        event: 'whatsapp:qr',
        payload: { channel_id: this.ctx.channelId, qr },
      })
    }

    if (connection === 'open') {
      this.currentQr = null
      const me = this.sock?.user
      const phone = me?.id ? extractPhoneFromJid(me.id) : null
      const displayName = me?.name ?? me?.verifiedName ?? undefined

      await this.markChannelActive(phone, displayName)

      void broadcastRealtime({
        org_id: this.ctx.orgId,
        event: 'whatsapp:connected',
        payload: {
          channel_id: this.ctx.channelId,
          phone_number: phone ?? '',
          ...(displayName ? { display_name: displayName } : {}),
        },
      })
    }

    if (connection === 'close') {
      const errOutput = (
        lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
      )?.output
      const code = errOutput?.statusCode
      const isLoggedOut = code === DisconnectReason.loggedOut
      const reason = isLoggedOut
        ? 'logged_out'
        : (lastDisconnect?.error?.message ?? `code:${code ?? 'unknown'}`)

      this.sock = null

      // eslint-disable-next-line no-console
      console.log(`[baileys ${this.ctx.channelId}] disconnected (code=${code} reason=${reason})`)

      if (isLoggedOut) {
        await this.auth?.clear()
        await this.markChannelDisconnected(reason)
        void broadcastRealtime({
          org_id: this.ctx.orgId,
          event: 'whatsapp:disconnected',
          payload: {
            channel_id: this.ctx.channelId,
            reason,
            needs_reauth: true,
          },
        })
        return
      }

      // Transient (restartRequired=515 é o caso mais comum no primeiro
      // pareamento). Baileys orienta a simplesmente reabrir o socket com
      // o mesmo auth state — reconexão silenciosa.
      if (this.terminated) return
      // eslint-disable-next-line no-console
      console.log(`[baileys ${this.ctx.channelId}] auto-restart em 1s (transient disconnect)`)
      setTimeout(() => {
        if (this.terminated) return
        void this.start().catch((err) => {
          // eslint-disable-next-line no-console
          console.error(
            `[baileys ${this.ctx.channelId}] auto-restart falhou:`,
            err instanceof Error ? err.message : err,
          )
        })
      }, 1000)
    }
  }

  /**
   * Recebe mensagens inbound. NO SAAS (sem CRM ainda) só logamos +
   * broadcast `message:new` pro frontend escutar via socket. Persistência
   * em tabelas de CRM (contacts/conversations/messages) é TODO futuro.
   */
  private async handleInbound(msg: WAMessage): Promise<void> {
    if (!msg.message || msg.key.fromMe) return // ignora outbound (eco) e tombstones

    const remoteJid = msg.key.remoteJid
    if (!remoteJid || remoteJid.endsWith('@g.us')) return // ignora grupos

    const isPhoneJid = remoteJid.endsWith('@s.whatsapp.net')
    const phone = isPhoneJid ? extractPhoneFromJid(remoteJid) : null
    const senderName = msg.pushName ?? undefined
    const messageId = msg.key.id ?? `${Date.now()}-${Math.random()}`

    const parsed = extractContent(msg.message)
    if (!parsed) return // tipo não suportado no MVP

    // eslint-disable-next-line no-console
    console.log(
      `[baileys ${this.ctx.channelId}] inbound from=${remoteJid} kind=${parsed.kind} msg_id=${messageId}`,
    )

    void broadcastRealtime({
      org_id: this.ctx.orgId,
      event: 'message:new',
      payload: {
        channel_id: this.ctx.channelId,
        wa_jid: remoteJid,
        phone,
        sender_name: senderName ?? null,
        channel_message_id: messageId,
        content: parsed,
        timestamp: msg.messageTimestamp ?? null,
      },
    })
  }

  // ──────────────────────────────────────────────────────────
  // DB helpers — só `channels` (sem CRM no SaaS por enquanto)
  // ──────────────────────────────────────────────────────────

  private async markChannelActive(phone: string | null, displayName: string | undefined): Promise<void> {
    const supabase = getSupabase()
    const patch: Record<string, unknown> = {
      status: 'active',
      error_message: null,
      last_webhook_at: new Date().toISOString(),
    }
    if (phone) patch.phone_number = phone
    if (displayName) patch.external_id = displayName
    await supabase.from('channels').update(patch).eq('id', this.ctx.channelId)
  }

  private async markChannelDisconnected(reason: string): Promise<void> {
    const supabase = getSupabase()
    await supabase
      .from('channels')
      .update({ status: 'disconnected', error_message: reason })
      .eq('id', this.ctx.channelId)
  }
}

// ──────────────────────────────────────────────────────────
// Pure helpers
// ──────────────────────────────────────────────────────────

function extractPhoneFromJid(jid: string): string | null {
  // JID: '5571999999999@s.whatsapp.net' ou '5571999999999:21@s.whatsapp.net'
  const m = /^(\d+)/.exec(jid)
  return m?.[1] ?? null
}

interface TextContent { kind: 'text'; body: string }
interface ImageContent { kind: 'image'; caption?: string; mime_type?: string }
interface AudioContent { kind: 'audio'; mime_type?: string; duration_seconds?: number }
interface VideoContent { kind: 'video'; caption?: string; mime_type?: string }
interface DocumentContent { kind: 'document'; filename?: string; mime_type?: string }

type ParsedContent = TextContent | ImageContent | AudioContent | VideoContent | DocumentContent

export type OutboundContent =
  | { kind: 'text'; body: string }
  | { kind: 'image'; url: string; caption?: string }
  | { kind: 'audio'; url: string; mime_type?: string; ptt?: boolean }
  | { kind: 'video'; url: string; caption?: string }
  | { kind: 'document'; url: string; filename?: string; mime_type?: string }

function extractContent(m: WAMessageContent): ParsedContent | null {
  if (m.conversation) return { kind: 'text', body: m.conversation }
  if (m.extendedTextMessage?.text) {
    return { kind: 'text', body: m.extendedTextMessage.text }
  }
  if (m.imageMessage) {
    return {
      kind: 'image',
      ...(m.imageMessage.caption ? { caption: m.imageMessage.caption } : {}),
      ...(m.imageMessage.mimetype ? { mime_type: m.imageMessage.mimetype } : {}),
    }
  }
  if (m.audioMessage) {
    return {
      kind: 'audio',
      ...(m.audioMessage.mimetype ? { mime_type: m.audioMessage.mimetype } : {}),
      ...(typeof m.audioMessage.seconds === 'number'
        ? { duration_seconds: m.audioMessage.seconds }
        : {}),
    }
  }
  if (m.videoMessage) {
    return {
      kind: 'video',
      ...(m.videoMessage.caption ? { caption: m.videoMessage.caption } : {}),
      ...(m.videoMessage.mimetype ? { mime_type: m.videoMessage.mimetype } : {}),
    }
  }
  if (m.documentMessage) {
    return {
      kind: 'document',
      ...(m.documentMessage.fileName ? { filename: m.documentMessage.fileName } : {}),
      ...(m.documentMessage.mimetype ? { mime_type: m.documentMessage.mimetype } : {}),
    }
  }
  return null
}
