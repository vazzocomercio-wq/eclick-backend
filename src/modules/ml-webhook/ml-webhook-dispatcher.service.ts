import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { MlPostsaleService } from '../ml-postsale/ml-postsale.service'
import { MlQuestionsAiService } from '../mercadolivre/ml-questions-ai.service'
import { MlClaimsService } from '../ml-vertical/services/ml-claims.service'
import { EventsGateway } from '../events/events.gateway'
import type { MlWebhookPayload } from './ml-webhook.types'

/**
 * Dispatcher dos webhooks ML. Resolve org_id pelo seller_id e roteia
 * por topic. Roda em fire-and-forget (chamado pelo controller que já
 * respondeu 200 ao ML — assim ML não retenta nem se nosso processamento
 * demorar).
 */
@Injectable()
export class MlWebhookDispatcherService {
  private readonly logger = new Logger(MlWebhookDispatcherService.name)

  constructor(
    private readonly postsale:  MlPostsaleService,
    private readonly questions: MlQuestionsAiService,
    private readonly claims:    MlClaimsService,
    private readonly events:    EventsGateway,
  ) {}

  async dispatch(payload: MlWebhookPayload): Promise<void> {
    if (!payload?.user_id || !payload?.topic) {
      this.logger.warn(`[ml-webhook] payload inválido: ${JSON.stringify(payload).slice(0, 200)}`)
      return
    }

    // Resolve org pela seller_id
    const orgId = await this.resolveOrgId(payload.user_id)
    if (!orgId) {
      // Webhook de um seller que não está conectado em nenhuma org da plataforma
      this.logger.warn(`[ml-webhook] seller=${payload.user_id} sem org conectada (topic=${payload.topic})`)
      return
    }

    try {
      switch (payload.topic) {
        case 'messages': {
          await this.postsale.handleMessageWebhook(orgId, payload.resource, payload.user_id)
          break
        }
        case 'questions': {
          // resource: /questions/{id}
          const m = payload.resource.match(/\/questions\/(\d+)/)
          const qid = m?.[1]
          if (qid) {
            await this.questions.handleQuestionWebhook(orgId, qid)
          } else {
            this.logger.warn(`[ml-webhook] questions resource sem id: ${payload.resource}`)
          }
          break
        }
        case 'claims': {
          // resource: /post-purchase/v1/claims/{id} ou /claims/{id}
          await this.claims.handleClaimWebhook(orgId, payload.user_id, payload.resource)
          break
        }
        case 'orders_v2':
        case 'shipments': {
          // resource: /orders/{id} ou /shipments/{id}
          // Por agora NÃO refazemos ingestion no momento (o aggregator
          // periódico já cobre — adicionar fetchSingleOrder requer
          // refactor do client). Mas EMITIMOS Socket.IO pra UI saber que
          // tem mudança e refrescar a lista.
          const m = payload.resource.match(/\/(orders|shipments)\/(\d+)/)
          const externalOrderId = m?.[2]
          this.events.emitToOrg(orgId, 'order:invalidate', {
            external_order_id: externalOrderId ?? null,
            seller_id:         payload.user_id,
            topic:             payload.topic,
            resource:          payload.resource,
            received_at:       new Date().toISOString(),
          })
          this.logger.log(`[ml-webhook] orders_v2 emit pra org=${orgId} order=${externalOrderId}`)
          break
        }
        default:
          // Topics ainda não tratados: items...
          this.logger.log(`[ml-webhook] topic ${payload.topic} ignorado (org=${orgId} resource=${payload.resource})`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(`[ml-webhook] dispatch falhou topic=${payload.topic} org=${orgId}: ${msg}`)
    }
  }

  private async resolveOrgId(sellerId: number): Promise<string | null> {
    const { data } = await supabaseAdmin
      .from('ml_connections')
      .select('organization_id')
      .eq('seller_id', sellerId)
      .limit(1)
      .maybeSingle()
    return (data as { organization_id?: string } | null)?.organization_id ?? null
  }
}
