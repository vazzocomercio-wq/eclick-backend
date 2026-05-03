import {
  Injectable, Logger, BadRequestException,
  ServiceUnavailableException, OnModuleDestroy,
} from '@nestjs/common'
import type { Response } from 'express'
import axios, { AxiosError } from 'axios'
import { supabaseAdmin } from '../../common/supabase'

/** Sprint F5-3 / Batch 1 — WhatsApp Gratuito (Baileys).
 *
 * Esse service é a ponte entre a API NestJS (web) e o worker Baileys
 * (process separado no Railway). Comunicação:
 *   API → Worker:  HTTP via BAILEYS_WORKER_URL + x-internal-key
 *   Worker → API:  HTTP em /whatsapp-free/internal/* (mesma key)
 *
 * O service mantém um Map<orgId, Response[]> de clientes SSE — quando o worker
 * notifica QR/status, fan-out pra todos os clientes da org.
 *
 * Escopo dessa sprint: conectar/desconectar/status. Sem envio, sem recepção.
 */

const TABLE = 'whatsapp_free_sessions'
const SESSION_NAME = 'default'

const BAILEYS_WORKER_URL = process.env.BAILEYS_WORKER_URL
const INTERNAL_API_KEY   = process.env.INTERNAL_API_KEY

interface SessionRow {
  organization_id: string
  status: 'disconnected' | 'connecting' | 'qr_pending' | 'active' | 'error'
  phone_number: string | null
  phone_name: string | null
  last_connected_at: string | null
  last_disconnected_at: string | null
  error_message: string | null
}

export interface WfStatus {
  status: SessionRow['status']
  phone: string | null
  name: string | null
  last_connected_at: string | null
  worker_online: boolean
  configured: boolean
}

@Injectable()
export class WhatsAppFreeService implements OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppFreeService.name)
  /** orgId → lista de Response abertos. Limpeza no req.on('close'). */
  private readonly sseClients = new Map<string, Set<Response>>()
  /** Heartbeat pra manter SSE vivo atrás de proxies. */
  private heartbeat: NodeJS.Timeout | null = null

  constructor() {
    this.heartbeat = setInterval(() => this.sendHeartbeat(), 25_000)
  }

  onModuleDestroy(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    for (const set of this.sseClients.values()) {
      for (const res of set) {
        try { res.end() } catch { /* ignore */ }
      }
    }
    this.sseClients.clear()
  }

  // ── Worker calls ───────────────────────────────────────────────────────

  private requireWorkerConfig(): { url: string; key: string } {
    if (!BAILEYS_WORKER_URL || !INTERNAL_API_KEY) {
      throw new ServiceUnavailableException(
        'WhatsApp Gratuito não configurado pelo administrador (BAILEYS_WORKER_URL/INTERNAL_API_KEY ausentes).',
      )
    }
    return { url: BAILEYS_WORKER_URL, key: INTERNAL_API_KEY }
  }

  private isWorkerOfflineError(e: unknown): boolean {
    if (!axios.isAxiosError(e)) return false
    const ax = e as AxiosError
    return !ax.response || ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'].includes(ax.code ?? '')
  }

  async createSession(orgId: string): Promise<{ ok: true }> {
    const { url, key } = this.requireWorkerConfig()
    try {
      await axios.post(
        `${url}/internal/baileys/create-session`,
        { orgId },
        { headers: { 'x-internal-key': key }, timeout: 15_000 },
      )
      return { ok: true }
    } catch (e) {
      if (this.isWorkerOfflineError(e)) {
        throw new ServiceUnavailableException('Serviço WhatsApp Gratuito offline. Tente novamente em instantes.')
      }
      const msg = axios.isAxiosError(e) ? (e.response?.data?.error ?? e.message) : (e as Error).message
      this.logger.error(`[wf.create] orgId=${orgId} falhou: ${msg}`)
      throw new BadRequestException(`Falha ao criar sessão: ${msg}`)
    }
  }

  async disconnectSession(orgId: string): Promise<{ ok: true }> {
    const { url, key } = this.requireWorkerConfig()
    try {
      await axios.post(
        `${url}/internal/baileys/disconnect`,
        { orgId },
        { headers: { 'x-internal-key': key }, timeout: 15_000 },
      )
      return { ok: true }
    } catch (e) {
      if (this.isWorkerOfflineError(e)) {
        // Pelo menos zera o status no banco
        await supabaseAdmin
          .from(TABLE)
          .update({ status: 'disconnected', updated_at: new Date().toISOString() })
          .eq('organization_id', orgId)
          .eq('session_name', SESSION_NAME)
        throw new ServiceUnavailableException('Serviço WhatsApp Gratuito offline. Status zerado localmente.')
      }
      const msg = axios.isAxiosError(e) ? (e.response?.data?.error ?? e.message) : (e as Error).message
      throw new BadRequestException(`Falha ao desconectar: ${msg}`)
    }
  }

  /** Status: prioriza memória do worker, fallback pro banco se worker offline. */
  async getStatus(orgId: string): Promise<WfStatus> {
    const { data } = await supabaseAdmin
      .from(TABLE)
      .select('status, phone_number, phone_name, last_connected_at, last_disconnected_at, error_message')
      .eq('organization_id', orgId)
      .eq('session_name', SESSION_NAME)
      .maybeSingle()

    const dbRow = (data as Partial<SessionRow> | null)
    const configured = Boolean(BAILEYS_WORKER_URL && INTERNAL_API_KEY)
    let workerOnline = false

    if (configured) {
      try {
        await axios.get(`${BAILEYS_WORKER_URL!}/health`, { timeout: 3_000 })
        workerOnline = true
      } catch {
        workerOnline = false
      }
    }

    return {
      status: dbRow?.status ?? 'disconnected',
      phone: dbRow?.phone_number ?? null,
      name: dbRow?.phone_name ?? null,
      last_connected_at: dbRow?.last_connected_at ?? null,
      worker_online: workerOnline,
      configured,
    }
  }

  // ── SSE management ─────────────────────────────────────────────────────

  addSseClient(orgId: string, res: Response): void {
    let set = this.sseClients.get(orgId)
    if (!set) {
      set = new Set<Response>()
      this.sseClients.set(orgId, set)
    }
    set.add(res)

    // Cleanup quando cliente fecha
    res.on('close', () => {
      const s = this.sseClients.get(orgId)
      if (!s) return
      s.delete(res)
      if (s.size === 0) this.sseClients.delete(orgId)
    })
  }

  emitSse(orgId: string, event: string, data: Record<string, unknown>): void {
    const set = this.sseClients.get(orgId)
    if (!set || set.size === 0) return
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of set) {
      try {
        res.write(payload)
      } catch (e) {
        this.logger.warn(`[wf.sse] write falhou orgId=${orgId}: ${(e as Error).message}`)
        set.delete(res)
      }
    }
  }

  private sendHeartbeat(): void {
    for (const set of this.sseClients.values()) {
      for (const res of set) {
        try {
          res.write(': heartbeat\n\n')
        } catch {
          set.delete(res)
        }
      }
    }
  }
}
