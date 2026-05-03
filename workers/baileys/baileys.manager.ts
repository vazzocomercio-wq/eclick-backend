import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { BaileysSession, SessionStatus } from './baileys.session'

const TABLE = 'whatsapp_free_sessions'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const INTERNAL_API_URL = process.env.INTERNAL_API_URL
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('[baileys-worker] SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY são obrigatórios')
}
if (!INTERNAL_API_URL || !INTERNAL_API_KEY) {
  throw new Error('[baileys-worker] INTERNAL_API_URL + INTERNAL_API_KEY são obrigatórios')
}

export class BaileysManager {
  private readonly sessions = new Map<string, BaileysSession>()
  private readonly supabase: SupabaseClient

  constructor() {
    this.supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }

  // ── Lifecycle pra orgs ─────────────────────────────────────────────────

  async createSession(orgId: string): Promise<void> {
    const existing = this.sessions.get(orgId)
    if (existing && existing.status === 'connecting') {
      return  // já conectando
    }
    if (existing) {
      await existing.disconnect().catch(() => undefined)
      this.sessions.delete(orgId)
    }

    const session = new BaileysSession(orgId, this.supabase, {
      onQr: async (qrBase64) => {
        await this.notifyApi('qr', { orgId, qrBase64 })
      },
      onStatus: async (status, phone, name, error) => {
        await this.notifyApi('status', { orgId, status, phone, name, error })
      },
    })
    this.sessions.set(orgId, session)

    try {
      await session.connect()
    } catch (e) {
      console.error(`[baileys.manager] createSession(${orgId}) falhou:`, e)
      this.sessions.delete(orgId)
      throw e
    }
  }

  async destroySession(orgId: string): Promise<void> {
    const session = this.sessions.get(orgId)
    if (!session) return
    await session.disconnect().catch(() => undefined)
    this.sessions.delete(orgId)
  }

  hasSession(orgId: string): boolean {
    return this.sessions.has(orgId)
  }

  getStatus(orgId: string): SessionStatus | null {
    return this.sessions.get(orgId)?.status ?? null
  }

  // ── Boot reconciliation: restaura sessões que estavam ativas ───────────

  async restoreActiveSessions(): Promise<void> {
    const { data, error } = await this.supabase
      .from(TABLE)
      .select('organization_id, status')
      .eq('status', 'active')

    if (error) {
      console.error(`[baileys.manager] restoreActiveSessions falhou:`, error.message)
      return
    }

    for (const row of data ?? []) {
      const orgId = row.organization_id as string
      if (this.sessions.has(orgId)) continue
      console.log(`[baileys.manager] restaurando sessão active orgId=${orgId}`)
      this.createSession(orgId).catch(e => {
        console.error(`[baileys.manager] restore(${orgId}) falhou:`, e)
      })
    }
  }

  // ── Safety net (60s): re-conecta sessões 'active' que sumiram do Map ──

  async reconcile(): Promise<void> {
    const { data } = await this.supabase
      .from(TABLE)
      .select('organization_id, status')
      .eq('status', 'active')

    for (const row of data ?? []) {
      const orgId = row.organization_id as string
      if (!this.sessions.has(orgId)) {
        console.log(`[baileys.manager] reconcile: orgId=${orgId} active no DB mas sem sessão local — recriando`)
        this.createSession(orgId).catch(e => {
          console.error(`[baileys.manager] reconcile(${orgId}) falhou:`, e)
        })
      }
    }
  }

  // ── Notifica a API (web service) pra emitir SSE pro frontend ───────────

  private async notifyApi(event: 'qr' | 'status', payload: Record<string, unknown>): Promise<void> {
    try {
      const res = await fetch(`${INTERNAL_API_URL}/whatsapp-free/internal/${event}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-key': INTERNAL_API_KEY!,
        },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        console.error(`[baileys.manager] notifyApi(${event}) status=${res.status}`)
      }
    } catch (e) {
      console.error(`[baileys.manager] notifyApi(${event}) falhou:`, (e as Error).message)
    }
  }
}
