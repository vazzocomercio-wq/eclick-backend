import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { hashIp } from '../../storefront-leads/storefront-leads.service'
import { isValidEventName, isValidModule } from '../catalog/events-catalog'
import { SessionService } from './session.service'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PROPERTIES_BYTES = 8 * 1024
const CHUNK = 100
const MAX_EVENTS_PER_BATCH = 500

// Privacy by default: nunca persistir PII no properties. Bate por substring
// (case-insensitive), então cobre customer_email, telefone_cliente, etc.
const SENSITIVE_KEY_HINTS = [
  'cpf', 'cnpj', 'email', 'mail', 'phone', 'fone', 'telefone', 'celular',
  'whatsapp', 'password', 'senha', 'token', 'secret', 'card', 'cartao',
]

export interface RawTelemetryEvent {
  event_name?:  string
  event_type?:  string
  module?:      string
  feature?:     string
  page_url?:    string
  referrer?:    string
  duration_ms?: number
  properties?:  Record<string, unknown>
}

@Injectable()
export class EventIngestionService {
  private readonly logger = new Logger(EventIngestionService.name)

  constructor(private readonly sessions: SessionService) {}

  /**
   * Recebe um batch de eventos do client, valida cada um contra o catálogo
   * canônico, descarta os inválidos, sanitiza properties (sem PII) e insere
   * em chunks. Nunca lança por evento individual — só conta accepted/rejected.
   */
  async ingestBatch(input: {
    orgId:       string
    userId:      string
    sessionId:   string
    events:      RawTelemetryEvent[]
    userAgent?:  string
    ip?:         string
    deviceType?: string
  }): Promise<{ accepted: number; rejected: number }> {
    const events = Array.isArray(input.events) ? input.events.slice(0, MAX_EVENTS_PER_BATCH) : []
    if (!UUID_RE.test(input.sessionId) || events.length === 0) {
      return { accepted: 0, rejected: events.length }
    }

    const ipHash = input.ip ? hashIp(input.ip) : null
    const userAgent = (input.userAgent ?? '').toString().slice(0, 500) || null

    const rows: Array<Record<string, unknown>> = []
    let rejected = 0

    for (const e of events) {
      if (!e || !isValidEventName(e.event_name) || !isValidModule(e.module)) {
        rejected++
        continue
      }
      rows.push({
        org_id:      input.orgId,
        user_id:     input.userId,
        session_id:  input.sessionId,
        event_name:  e.event_name,
        event_type:  this.deriveEventType(e.event_name, e.event_type),
        module:      e.module,
        feature:     this.str(e.feature, 80),
        page_url:    this.str(e.page_url, 2000),
        referrer:    this.str(e.referrer, 2000),
        duration_ms: Number.isFinite(e.duration_ms) ? Math.max(0, Math.round(e.duration_ms as number)) : null,
        properties:  this.sanitizeProperties(e.properties),
        user_agent:  userAgent,
        ip_hash:     ipHash,
      })
    }

    if (rows.length === 0) return { accepted: 0, rejected }

    // Garante a sessão antes dos eventos (idempotente).
    await this.sessions.ensure({
      orgId:      input.orgId,
      userId:     input.userId,
      sessionId:  input.sessionId,
      deviceType: input.deviceType,
    })

    let accepted = 0
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK)
      const { error } = await supabaseAdmin.from('telemetry_events').insert(chunk)
      if (error) {
        this.logger.warn(`[ingest] insert falhou (chunk ${i / CHUNK}): ${error.message}`)
        rejected += chunk.length
      } else {
        accepted += chunk.length
      }
    }

    return { accepted, rejected }
  }

  /** Deriva event_type do nome quando o client não manda explícito. */
  private deriveEventType(eventName: string, provided?: string): string {
    if (typeof provided === 'string' && provided.trim()) return provided.trim().slice(0, 20)
    if (eventName.startsWith('task.')) return 'task'
    if (eventName === 'page_view' || eventName === 'module_entered' || eventName === 'module_exited') {
      return 'navigation'
    }
    return 'action'
  }

  /** Remove chaves sensíveis e capa o tamanho. Privacy by default. */
  private sanitizeProperties(props: unknown): Record<string, unknown> {
    if (!props || typeof props !== 'object' || Array.isArray(props)) return {}
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      const key = k.toLowerCase()
      if (SENSITIVE_KEY_HINTS.some(h => key.includes(h))) continue
      clean[k] = v
    }
    if (JSON.stringify(clean).length > MAX_PROPERTIES_BYTES) {
      return { _oversized: true }
    }
    return clean
  }

  private str(v: unknown, max: number): string | null {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
  }
}
