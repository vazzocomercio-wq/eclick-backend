import { Injectable, Logger, BadRequestException, HttpException, HttpStatus } from '@nestjs/common'

/**
 * Onda 4 / A3 — Cliente HTTP que chama os endpoints do Active
 * (automation-bridge). Usa shared secret pra autenticação server-to-server.
 *
 * Setup necessário (env Railway SaaS):
 *   ACTIVE_AUTOMATION_BRIDGE_URL=https://active-api.eclick.app.br
 *   ACTIVE_AUTOMATION_BRIDGE_SECRET=<mesmo valor configurado no Active>
 *
 * Sem essas vars, o cliente vira no-op (loga warn e retorna { skipped: true }).
 */

interface NotifyLojistaInput {
  organization_id: string
  message:         string
  severity:        'critical' | 'high' | 'medium' | 'low' | 'opportunity'
  action_id?:      string
  deeplink?:       string
}

interface TriggerCartRecoveryInput {
  organization_id: string
  cart_ids?:       string[]
  segment?:        'abandoned_24h' | 'abandoned_48h' | 'abandoned_7d'
  template_key?:   string
  rate_limit_ms?:  number
}

export type BroadcastSegment = 'todos' | 'compradores' | 'interessados' | 'inativos'

interface SendBroadcastInput {
  organization_id:   string
  message:           string
  target_segment:    BroadcastSegment
  include_image?:    boolean
  image_url?:        string
  include_link?:     boolean
  link_url?:         string
  source_content_id?: string   // social_content.id pra rastreio
  rate_limit_ms?:    number    // delay entre mensagens (default 3000)
}

@Injectable()
export class ActiveBridgeClient {
  private readonly logger = new Logger(ActiveBridgeClient.name)

  isConfigured(): boolean {
    return Boolean(
      process.env.ACTIVE_AUTOMATION_BRIDGE_URL &&
      process.env.ACTIVE_AUTOMATION_BRIDGE_SECRET,
    )
  }

  private getEnv(): { url: string; secret: string } {
    const url    = process.env.ACTIVE_AUTOMATION_BRIDGE_URL
    const secret = process.env.ACTIVE_AUTOMATION_BRIDGE_SECRET
    if (!url || !secret) {
      throw new HttpException(
        'Active bridge não configurado — defina ACTIVE_AUTOMATION_BRIDGE_URL e _SECRET',
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }
    return { url: url.replace(/\/+$/, ''), secret }
  }

  async notifyLojista(input: NotifyLojistaInput): Promise<{
    sent?:               boolean
    queued_for_digest?:  boolean
    skipped?:            boolean
  }> {
    if (!this.isConfigured()) {
      this.logger.warn('[active-bridge] notifyLojista no-op (bridge não configurado)')
      return { skipped: true }
    }
    const { url, secret } = this.getEnv()

    try {
      const res = await fetch(`${url}/commerce/automation-bridge/notify-lojista`, {
        method: 'POST',
        headers: {
          'Content-Type':              'application/json',
          'X-Automation-Bridge-Token': secret,
        },
        body: JSON.stringify(input),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new BadRequestException(`Active responded ${res.status}: ${body.slice(0, 200)}`)
      }
      return await res.json() as { sent?: boolean; queued_for_digest?: boolean }
    } catch (e) {
      this.logger.error(`[active-bridge] notifyLojista falhou: ${(e as Error).message}`)
      throw e
    }
  }

  /** Health check sem spam: chama notify-lojista com severity='low'
   *  (que vai pra digest diário no Active, não dispara WhatsApp imediato).
   *  Retorna sucesso se Active validou o secret e gravou em
   *  automation_executions. Útil pra smoke test pós-setup das env vars. */
  async pingBridge(orgId: string): Promise<{
    configured:    boolean
    reachable:     boolean
    authenticated: boolean
    response?:     unknown
    error?:        string
  }> {
    if (!this.isConfigured()) {
      return { configured: false, reachable: false, authenticated: false, error: 'Env vars não setadas' }
    }
    const { url, secret } = this.getEnv()

    try {
      const res = await fetch(`${url}/commerce/automation-bridge/notify-lojista`, {
        method: 'POST',
        headers: {
          'Content-Type':              'application/json',
          'X-Automation-Bridge-Token': secret,
        },
        body: JSON.stringify({
          organization_id: orgId,
          message:         '🔍 Bridge SaaS↔Active health check (ignore esta mensagem — irá pro digest diário e não dispara WhatsApp imediato).',
          severity:        'low' as const,
        }),
      })
      const body = await res.text()

      if (res.status === 401 || res.status === 403) {
        return { configured: true, reachable: true, authenticated: false, error: `Active rejeitou auth: ${body.slice(0, 200)}` }
      }
      if (!res.ok) {
        return { configured: true, reachable: true, authenticated: false, error: `Active respondeu ${res.status}: ${body.slice(0, 200)}` }
      }

      let parsed: unknown
      try { parsed = JSON.parse(body) } catch { parsed = body }
      return { configured: true, reachable: true, authenticated: true, response: parsed }
    } catch (e) {
      return { configured: true, reachable: false, authenticated: false, error: (e as Error).message }
    }
  }

  /** Dispara WhatsApp broadcast pra um segmento (ou lista de contatos)
   *  via Active. Texto vem pronto do SaaS (Conteúdo Social), Active só
   *  resolve audiência e usa WhatsAppService.sendText com rate limit. */
  async sendBroadcast(input: SendBroadcastInput): Promise<{
    dispatched?: number
    skipped?:    number
    errors?:     number
    skipped_no_bridge?: boolean
  }> {
    if (!this.isConfigured()) {
      this.logger.warn('[active-bridge] sendBroadcast no-op (bridge não configurado)')
      return { skipped_no_bridge: true }
    }
    const { url, secret } = this.getEnv()

    try {
      const res = await fetch(`${url}/commerce/automation-bridge/send-broadcast`, {
        method: 'POST',
        headers: {
          'Content-Type':              'application/json',
          'X-Automation-Bridge-Token': secret,
        },
        body: JSON.stringify(input),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new BadRequestException(`Active responded ${res.status}: ${body.slice(0, 200)}`)
      }
      return await res.json() as { dispatched: number; skipped: number; errors: number }
    } catch (e) {
      this.logger.error(`[active-bridge] sendBroadcast falhou: ${(e as Error).message}`)
      throw e
    }
  }

  async triggerCartRecovery(input: TriggerCartRecoveryInput): Promise<{
    dispatched?: number
    skipped?:    number
    errors?:     number
  }> {
    if (!this.isConfigured()) {
      this.logger.warn('[active-bridge] triggerCartRecovery no-op (bridge não configurado)')
      return { skipped: 0 }
    }
    const { url, secret } = this.getEnv()

    try {
      const res = await fetch(`${url}/commerce/automation-bridge/trigger-cart-recovery`, {
        method: 'POST',
        headers: {
          'Content-Type':              'application/json',
          'X-Automation-Bridge-Token': secret,
        },
        body: JSON.stringify(input),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new BadRequestException(`Active responded ${res.status}: ${body.slice(0, 200)}`)
      }
      return await res.json() as { dispatched: number; skipped: number; errors: number }
    } catch (e) {
      this.logger.error(`[active-bridge] triggerCartRecovery falhou: ${(e as Error).message}`)
      throw e
    }
  }
}
