import { Injectable, Logger } from '@nestjs/common'
import { AlertSignalsService } from '../intelligence-hub/alert-signals.service'
import { AlertEngineService } from '../intelligence-hub/alert-engine.service'
import type { SignalDraft } from '../intelligence-hub/analyzers/analyzers.types'

/**
 * Ponte AtendenteIA → Intelligence Hub.
 *
 * Quando uma conversa escala (cliente reclama, agente sem confiança, modo
 * sempre-escalar) ou o LLM responde com confidence baixa o suficiente pra
 * cair em queue_for_human, o gestor responsável precisa ser notificado por
 * WhatsApp — mesma pipeline dos analyzers (estoque/compras/margem...).
 *
 * Em vez de duplicar lógica de routing/digest/throttle, emitimos signals
 * com analyzer='atendente_ia' e deixamos AlertEngine + WhatsAppDeliveryService
 * fazerem o trabalho. Categorias suportadas:
 *
 *   - 'escalation_complaint'      → cliente reclamou (severity: critical)
 *   - 'escalation_low_confidence' → confiança < queue_threshold (severity: warning)
 *   - 'escalation_always'         → flag always_escalate do agente (severity: warning)
 *   - 'escalation_human_only'     → canal em modo 'human' (severity: info)
 *
 * Idempotência por (entity_type='conversation', entity_id=conversationId)
 * com janela curta (15min) — se o cliente continua mandando msgs no mesmo
 * ticket, não geramos signal novo a cada turno.
 */
@Injectable()
export class AiHubBridgeService {
  private readonly logger = new Logger(AiHubBridgeService.name)

  // Janela curta — uma escalação só vira signal 1x por 15min por conversa.
  // 24h padrão do Hub é demais aqui (turn-rate de chat é alto).
  private static DEDUP_WINDOW_MIN = 15

  constructor(
    private readonly signals: AlertSignalsService,
    private readonly engine:  AlertEngineService,
  ) {}

  /**
   * Emite signal de escalação.  Não-fatal: erros de Hub não devem quebrar
   * o fluxo de resposta do AtendenteIA.
   */
  async emitEscalation(input: {
    orgId:            string
    conversationId:   string
    customerName?:    string | null
    channel:          string                 // 'mercadolivre' | 'whatsapp' | 'widget'
    reason:           'complaint' | 'low_confidence' | 'always_escalate' | 'human_only'
    confidence?:      number                 // 0..100 (presente quando reason=low_confidence)
    summary:          string                 // Mensagem do cliente ou contexto
    queueThreshold?:  number                 // referência pro signal data
  }): Promise<void> {
    try {
      const recent = await this.signals.findRecentByEntity(
        input.orgId,
        'conversation',
        input.conversationId,
        AiHubBridgeService.DEDUP_WINDOW_MIN,
      )
      const sameReasonRecently = recent.some(s => s.category === this.categoryFor(input.reason))
      if (sameReasonRecently) return  // dedup

      const draft = this.buildDraft(input)
      const inserted = await this.signals.insertMany(input.orgId, [draft])
      if (inserted.length === 0) return
      await this.engine.processMany(input.orgId, inserted)
    } catch (e: any) {
      this.logger.warn(`[ai-hub.emitEscalation] org=${input.orgId} conv=${input.conversationId}: ${e?.message}`)
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private categoryFor(reason: 'complaint' | 'low_confidence' | 'always_escalate' | 'human_only'): string {
    switch (reason) {
      case 'complaint':        return 'escalation_complaint'
      case 'low_confidence':   return 'escalation_low_confidence'
      case 'always_escalate':  return 'escalation_always'
      case 'human_only':       return 'escalation_human_only'
    }
  }

  private buildDraft(input: {
    orgId:            string
    conversationId:   string
    customerName?:    string | null
    channel:          string
    reason:           'complaint' | 'low_confidence' | 'always_escalate' | 'human_only'
    confidence?:      number
    summary:          string
    queueThreshold?:  number
  }): SignalDraft {
    const sevByReason = {
      complaint:        'critical',
      low_confidence:   'warning',
      always_escalate:  'warning',
      human_only:       'info',
    } as const
    const scoreByReason = {
      complaint:        90,
      low_confidence:   60,
      always_escalate:  60,
      human_only:       40,
    } as const

    const customer = input.customerName?.trim() || 'cliente'
    const channelLabel = input.channel === 'mercadolivre' ? 'Mercado Livre' :
                         input.channel === 'whatsapp'     ? 'WhatsApp'      :
                         input.channel === 'widget'       ? 'Widget'        : input.channel

    const summary_pt =
      input.reason === 'complaint'      ? `Reclamação de ${customer} via ${channelLabel}` :
      input.reason === 'low_confidence' ? `Resposta com baixa confiança no atendimento de ${customer} (${channelLabel})` :
      input.reason === 'always_escalate'? `Mensagem de ${customer} em ${channelLabel} marcada para revisão humana` :
                                          `${customer} em modo humano-apenas (${channelLabel})`

    const suggestion_pt =
      input.reason === 'complaint'      ? 'Atender o cliente o quanto antes — reclamação detectada por palavra-chave' :
      input.reason === 'low_confidence' ? 'Revisar a sugestão da IA na fila e aprovar/editar/discartar' :
      input.reason === 'always_escalate'? 'Conferir a sugestão da IA na fila' :
                                          'Responder manualmente — canal configurado pra humano-apenas'

    return {
      analyzer:    'atendente_ia',
      category:    this.categoryFor(input.reason),
      severity:    sevByReason[input.reason],
      score:       scoreByReason[input.reason],
      entity_type: null,                              // 'conversation' não está no enum AlertEntityType
      entity_id:   input.conversationId,
      entity_name: customer,
      data: {
        conversation_id:  input.conversationId,
        channel:          input.channel,
        customer_name:    customer,
        reason:           input.reason,
        confidence:       input.confidence ?? null,
        queue_threshold:  input.queueThreshold ?? null,
        message_excerpt:  input.summary.slice(0, 280),
      },
      summary_pt,
      suggestion_pt,
      // Sinal de chat tem janela curta — se gestor não viu em 4h, provavelmente
      // já passou demais pra ser útil; cron limpa expired.
      expires_at: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    }
  }
}
