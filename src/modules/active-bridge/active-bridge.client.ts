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

interface CreateCampaignCardInput {
  organization_id: string
  pipeline_id:     string
  stage_id:        string
  assigned_to:     string
  title:           string
  task_title:      string
  due_date?:       string
  value?:          number
  tags?:           string[]
  metadata?:       Record<string, unknown>
  dedup_key?:      string
}

export interface CreateCampaignCardResult {
  ok?:                true
  deal_id?:           string
  task_id?:           string | null
  created?:           boolean
  skipped_no_bridge?: boolean
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

interface CardActionLink {
  label: string
  url:   string
}

interface MoveCardInput {
  /** Org dona do card — obrigatório se for achar por dedup_key. */
  organization_id?: string
  /** Chave lógica do card (custom_fields.dedup_key). */
  dedup_key?:       string
  /** Id direto do deal — se vier, Active deriva a org do próprio deal. */
  deal_id?:         string
  to_stage_id?:     string
  to_stage_name?:   string
  /** Botão contextual do card. `null` limpa; omitir mantém. */
  action_link?:     CardActionLink | null
}

export interface MoveCardResult {
  ok?:                true
  found?:             boolean
  deal_id?:           string | null
  moved?:             boolean
  reason?:            string
  skipped_no_bridge?: boolean
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
  /** Envia mensagem WhatsApp direta pra UM contato específico
   *  (não-segmento). Usado em notificações transacionais da Loja Própria:
   *  pedido pago, enviado, entregue, promoção de tier.
   *
   *  Endpoint Active esperado: POST /commerce/automation-bridge/send-direct
   *  com { organization_id, phone (E.164 ou nacional), message, dedup_key? }.
   *
   *  Se Active não tem o endpoint ainda, retorna { skipped_no_bridge: true }
   *  silenciosamente — notificação é feature opcional. */
  async sendDirectMessage(input: {
    organization_id: string
    phone:           string                // E.164 preferido (+55...) ou nacional (11)
    message:         string
    dedup_key?:      string                // pra idempotência ("order:xxx:shipped")
  }): Promise<{ sent?: boolean; skipped_no_bridge?: boolean; error?: string }> {
    if (!this.isConfigured()) {
      this.logger.warn('[active-bridge] sendDirectMessage no-op (bridge não configurado)')
      return { skipped_no_bridge: true }
    }
    const { url, secret } = this.getEnv()

    try {
      const res = await fetch(`${url}/commerce/automation-bridge/send-direct`, {
        method: 'POST',
        headers: {
          'Content-Type':              'application/json',
          'X-Automation-Bridge-Token': secret,
        },
        body: JSON.stringify(input),
      })
      if (res.status === 404) {
        // Endpoint não existe ainda no Active — não é erro, apenas no-op.
        this.logger.warn('[active-bridge] sendDirectMessage skipped — endpoint não existe no Active')
        return { skipped_no_bridge: true }
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        this.logger.warn(`[active-bridge] sendDirectMessage HTTP ${res.status}: ${body.slice(0, 200)}`)
        return { skipped_no_bridge: true, error: `${res.status}` }
      }
      return await res.json() as { sent?: boolean }
    } catch (e) {
      this.logger.warn(`[active-bridge] sendDirectMessage falhou: ${(e as Error).message}`)
      return { skipped_no_bridge: true, error: (e as Error).message }
    }
  }

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

  /** M4 — cria card no funil "Campanhas/Promoção" + task vinculada no
   *  Active. Chamado pelo MlCampaignsAlertsService quando um deadline
   *  alert dispara ou quando uma reco vai pra fila do gestor.
   *
   *  No-op se bridge não configurado (volta { skipped_no_bridge: true })
   *  ou se input.pipeline_id ausente (org não preencheu config M4 ainda). */
  async createCampaignCard(input: CreateCampaignCardInput): Promise<CreateCampaignCardResult> {
    if (!this.isConfigured()) {
      return { skipped_no_bridge: true }
    }
    if (!input.pipeline_id || !input.stage_id || !input.assigned_to) {
      this.logger.warn('[active-bridge] createCampaignCard skipped — config incompleto (pipeline_id/stage_id/assigned_to)')
      return { skipped_no_bridge: true }
    }
    const { url, secret } = this.getEnv()

    try {
      const res = await fetch(`${url}/commerce/automation-bridge/create-campaign-card`, {
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
      return await res.json() as CreateCampaignCardResult
    } catch (e) {
      this.logger.error(`[active-bridge] createCampaignCard falhou: ${(e as Error).message}`)
      throw e
    }
  }

  /** Avança um card existente no funil "Anúncios ML" do Active e atualiza
   *  o botão contextual (`action_link`). Usado pelo fluxo de publicação ML
   *  do SaaS: anúncio publicado+sincronizado → "Incluir Campanha", etc.
   *
   *  Acha o card por `deal_id` direto OU por `organization_id` + `dedup_key`.
   *  Avança só pra frente — Active ignora se o card já passou da etapa.
   *  No-op se bridge não configurado. */
  async moveCard(input: MoveCardInput): Promise<MoveCardResult> {
    if (!this.isConfigured()) {
      this.logger.warn('[active-bridge] moveCard no-op (bridge não configurado)')
      return { skipped_no_bridge: true }
    }
    if (!input.deal_id && (!input.organization_id || !input.dedup_key)) {
      this.logger.warn('[active-bridge] moveCard skipped — informe deal_id ou organization_id+dedup_key')
      return { skipped_no_bridge: true }
    }
    const { url, secret } = this.getEnv()

    try {
      const res = await fetch(`${url}/commerce/automation-bridge/move-card`, {
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
      return await res.json() as MoveCardResult
    } catch (e) {
      this.logger.error(`[active-bridge] moveCard falhou: ${(e as Error).message}`)
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
