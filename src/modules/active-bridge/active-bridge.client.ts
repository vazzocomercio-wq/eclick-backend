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
  assigned_to?:    string
  title:           string
  task_title:      string
  due_date?:       string
  value?:          number
  tags?:           string[]
  metadata?:       Record<string, unknown>
  contact_id?:     string
  dedup_key?:      string
}

export interface EnsureServicePipelineResult {
  ok?:                true
  pipeline_id?:       string
  default_stage_id?:  string
  stages?:            Array<{ id: string; name: string }>
  created?:           boolean
  skipped_no_bridge?: boolean
}

export interface CreateLeadInput {
  organization_id: string
  pipeline_id:     string
  stage_id:        string
  assigned_to?:    string
  contact:         { name?: string; email?: string; phone?: string }
  title?:          string
  message?:        string
  custom_fields?:  Record<string, unknown>
  tags?:           string[]
  dedup_key?:      string
}

export interface CreateLeadResult {
  ok?:                true
  deal_id?:           string
  contact_id?:        string | null
  assigned_to?:       string | null
  created?:           boolean
  skipped_no_bridge?: boolean
}

export interface RequestSchedulingInput {
  organization_id: string
  phone:           string
  name?:           string
  specialty?:      string | null
  intro_message?:  string | null
  origin_message?: string | null
}

export interface RequestSchedulingResult {
  ok?:                true
  proposed?:          boolean
  reason?:            string
  skipped_no_bridge?: boolean
}

export interface UpsertContactInput {
  organization_id: string
  name?:           string
  email?:          string
  phone?:          string
  tags?:           string[]
  source?:         string
}

export interface UpsertContactResult {
  ok?:                true
  contact_id?:        string | null
  created?:           boolean
  skipped_no_bridge?: boolean
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
    image_urls?:     string[]              // imagens (https) — 1ª leva message como legenda
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
    if (!input.pipeline_id || !input.stage_id) {
      this.logger.warn('[active-bridge] createCampaignCard skipped — config incompleto (pipeline_id/stage_id)')
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

  /** Cria um lead (contato + deal no funil escolhido) no Active a partir
   *  de um formulário da Loja Própria. No-op se bridge não configurado. */
  async createLead(input: CreateLeadInput): Promise<CreateLeadResult> {
    if (!this.isConfigured()) {
      return { skipped_no_bridge: true }
    }
    if (!input.pipeline_id || !input.stage_id) {
      this.logger.warn('[active-bridge] createLead skipped — pipeline_id/stage_id ausente')
      return { skipped_no_bridge: true }
    }
    const { url, secret } = this.getEnv()
    try {
      const res = await fetch(`${url}/commerce/automation-bridge/create-lead`, {
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
      return await res.json() as CreateLeadResult
    } catch (e) {
      this.logger.error(`[active-bridge] createLead falhou: ${(e as Error).message}`)
      throw e
    }
  }

  /** Pede ao Concierge do Active pra propor 3 horários de demo pra um lead
   *  (Auditoria GEO pública). Acha/cria contato + conversa WhatsApp e dispara
   *  o fluxo de slots. No-op se bridge não configurado / endpoint ausente. */
  async requestScheduling(input: RequestSchedulingInput): Promise<RequestSchedulingResult> {
    if (!this.isConfigured()) return { skipped_no_bridge: true }
    const { url, secret } = this.getEnv()
    try {
      const res = await fetch(`${url}/commerce/automation-bridge/request-scheduling`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Automation-Bridge-Token': secret },
        body: JSON.stringify(input),
      })
      if (res.status === 404) {
        this.logger.warn('[active-bridge] requestScheduling skipped — endpoint não existe no Active')
        return { skipped_no_bridge: true }
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        this.logger.warn(`[active-bridge] requestScheduling HTTP ${res.status}: ${body.slice(0, 200)}`)
        return { skipped_no_bridge: true, reason: `${res.status}` }
      }
      return await res.json() as RequestSchedulingResult
    } catch (e) {
      this.logger.warn(`[active-bridge] requestScheduling falhou: ${(e as Error).message}`)
      return { skipped_no_bridge: true, reason: (e as Error).message }
    }
  }

  /** Cria/acha um contato no Active (sem abrir card). Usado pelo Ambientador
   *  IA da Loja Própria: ao validar o WhatsApp do cliente, registra o contato
   *  e devolve o contact_id pra guardar no SaaS. No-op se bridge não
   *  configurado ou se o endpoint ainda não existe no Active (404). */
  async upsertContact(input: UpsertContactInput): Promise<UpsertContactResult> {
    if (!this.isConfigured()) {
      return { skipped_no_bridge: true }
    }
    if (!input.phone && !input.email) {
      this.logger.warn('[active-bridge] upsertContact skipped — sem phone/email')
      return { skipped_no_bridge: true }
    }
    const { url, secret } = this.getEnv()
    try {
      const res = await fetch(`${url}/commerce/automation-bridge/upsert-contact`, {
        method: 'POST',
        headers: {
          'Content-Type':              'application/json',
          'X-Automation-Bridge-Token': secret,
        },
        body: JSON.stringify(input),
      })
      if (res.status === 404) {
        this.logger.warn('[active-bridge] upsertContact skipped — endpoint não existe no Active')
        return { skipped_no_bridge: true }
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        this.logger.warn(`[active-bridge] upsertContact HTTP ${res.status}: ${body.slice(0, 200)}`)
        return { skipped_no_bridge: true }
      }
      return await res.json() as UpsertContactResult
    } catch (e) {
      this.logger.warn(`[active-bridge] upsertContact falhou: ${(e as Error).message}`)
      return { skipped_no_bridge: true }
    }
  }

  /** Garante (idempotente) um funil dedicado de atendimento pra org no
   *  Active, com etapas padrão. Devolve o pipeline_id + a etapa de entrada.
   *  No-op se bridge não configurado / endpoint ausente (404). */
  async ensureServicePipeline(input: {
    organization_id: string
    name?:           string
    stages?:         string[]
  }): Promise<EnsureServicePipelineResult> {
    if (!this.isConfigured()) return { skipped_no_bridge: true }
    const { url, secret } = this.getEnv()
    try {
      const res = await fetch(`${url}/commerce/automation-bridge/ensure-service-pipeline`, {
        method: 'POST',
        headers: {
          'Content-Type':              'application/json',
          'X-Automation-Bridge-Token': secret,
        },
        body: JSON.stringify(input),
      })
      if (res.status === 404) {
        this.logger.warn('[active-bridge] ensureServicePipeline skipped — endpoint não existe no Active')
        return { skipped_no_bridge: true }
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        this.logger.warn(`[active-bridge] ensureServicePipeline HTTP ${res.status}: ${body.slice(0, 200)}`)
        return { skipped_no_bridge: true }
      }
      return await res.json() as EnsureServicePipelineResult
    } catch (e) {
      this.logger.warn(`[active-bridge] ensureServicePipeline falhou: ${(e as Error).message}`)
      return { skipped_no_bridge: true }
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
