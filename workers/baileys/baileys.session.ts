import makeWASocket, {
  DisconnectReason, fetchLatestBaileysVersion,
  WASocket, ConnectionState,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { toDataURL } from 'qrcode'
import P from 'pino'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useDbAuthState, clearDbAuthState } from './auth-store'

const TABLE = 'whatsapp_free_sessions'
const SESSION_NAME = 'default'
const silentLogger = P({ level: 'silent' })

export type SessionStatus = 'disconnected' | 'connecting' | 'qr_pending' | 'active' | 'error'

export interface SessionEvents {
  onQr: (qrBase64: string) => void | Promise<void>
  onStatus: (status: SessionStatus, phone?: string, name?: string, error?: string) => void | Promise<void>
}

/** Sessão Baileys de UMA org. Multi-tenant: 1 instância dessa classe por orgId.
 * NÃO faz envio nem recepção nessa sprint — só QR + ciclo de vida. */
export class BaileysSession {
  private sock: WASocket | null = null
  private currentStatus: SessionStatus = 'disconnected'

  constructor(
    public readonly orgId: string,
    private readonly supabase: SupabaseClient,
    private readonly events: SessionEvents,
  ) {}

  get status(): SessionStatus {
    return this.currentStatus
  }

  async connect(): Promise<void> {
    if (this.sock) {
      // Já conectando — ignora
      return
    }
    await this.setStatus('connecting')

    const { version } = await fetchLatestBaileysVersion()
    const auth = await useDbAuthState(this.supabase, this.orgId)

    this.sock = makeWASocket({
      version,
      auth: auth.state,
      logger: silentLogger,
      browser: ['e-Click', 'Chrome', '1.0.0'],
    })

    this.sock.ev.on('creds.update', async () => {
      try { await auth.saveCreds() } catch (e) {
        console.error(`[baileys.session ${this.orgId}] saveCreds falhou:`, e)
      }
    })

    this.sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        try {
          const qrBase64 = await toDataURL(qr)
          await this.setStatus('qr_pending')
          await this.events.onQr(qrBase64)
        } catch (e) {
          console.error(`[baileys.session ${this.orgId}] QR encode falhou:`, e)
        }
      }

      if (connection === 'open') {
        const phone = this.sock?.user?.id?.split(':')[0] ?? this.sock?.user?.id?.split('@')[0]
        const name = this.sock?.user?.name ?? null
        await this.setStatus('active', phone ?? undefined, name ?? undefined)
        await this.events.onStatus('active', phone ?? undefined, name ?? undefined)
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
        const loggedOut = code === DisconnectReason.loggedOut
        this.sock = null

        if (loggedOut) {
          await clearDbAuthState(this.supabase, this.orgId)
          await this.setStatus('disconnected')
          await this.events.onStatus('disconnected')
        } else {
          // Reconnect transient — Baileys tipicamente fecha + abre. Não
          // re-conecta automaticamente aqui; manager faz reconciliação no boot.
          const errMsg = (lastDisconnect?.error as Error | undefined)?.message ?? 'desconectado'
          await this.setStatus('error', undefined, undefined, errMsg)
          await this.events.onStatus('error', undefined, undefined, errMsg)
        }
      }
    })
  }

  async disconnect(): Promise<void> {
    if (!this.sock) {
      await this.setStatus('disconnected')
      return
    }
    try {
      await this.sock.logout()
    } catch (e) {
      // logout pode falhar se já desconectado — engole
      console.warn(`[baileys.session ${this.orgId}] logout falhou (ignorado):`, (e as Error).message)
    }
    this.sock = null
    await clearDbAuthState(this.supabase, this.orgId)
    await this.setStatus('disconnected')
  }

  // ── Persist status ─────────────────────────────────────────────────────

  private async setStatus(
    status: SessionStatus,
    phone?: string,
    name?: string,
    error?: string,
  ): Promise<void> {
    this.currentStatus = status
    const payload: Record<string, unknown> = {
      organization_id: this.orgId,
      session_name: SESSION_NAME,
      status,
      updated_at: new Date().toISOString(),
    }
    if (phone) payload.phone_number = phone
    if (name)  payload.phone_name = name
    if (error) payload.error_message = error
    if (status === 'active')       payload.last_connected_at = new Date().toISOString()
    if (status === 'disconnected') payload.last_disconnected_at = new Date().toISOString()

    const { error: dbErr } = await this.supabase
      .from(TABLE)
      .upsert(payload, { onConflict: 'organization_id,session_name' })
    if (dbErr) {
      console.error(`[baileys.session ${this.orgId}] setStatus(${status}) falhou:`, dbErr.message)
    }
  }
}
