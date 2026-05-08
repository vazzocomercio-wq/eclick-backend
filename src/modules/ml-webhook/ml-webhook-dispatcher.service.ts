import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { MlPostsaleService } from '../ml-postsale/ml-postsale.service'
import { MlQuestionsAiService } from '../mercadolivre/ml-questions-ai.service'
import { MlClaimsService } from '../ml-vertical/services/ml-claims.service'
import { EventsGateway } from '../events/events.gateway'
import { OrdersIngestionService } from '../sales-aggregator/services/orders-ingestion.service'
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
    private readonly ingestion: OrdersIngestionService,
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
          const m = payload.resource.match(/\/(orders|shipments)\/(\d+)/)
          const kind = m?.[1] as 'orders' | 'shipments' | undefined
          const externalId = m?.[2]

          // orders_v2 → ingest single order ANTES do emit (zero latência).
          // shipments → não tem como ingest direto (id é shipment, não order),
          // mas o pedido relacionado já existe na DB; emit basta pra UI
          // re-fetch e pegar status atualizado pelo próximo aggregator OU
          // a app continua mostrando dados da última ingestion.
          let upserted = 0
          if (payload.topic === 'orders_v2' && externalId) {
            try {
              const r = await this.ingestion.ingestSingleOrder(orgId, externalId)
              upserted = r.upserted
              if (r.skipped) {
                this.logger.warn(`[ml-webhook] single-ingest skipped order=${externalId}: ${r.reason}`)
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              this.logger.error(`[ml-webhook] single-ingest order=${externalId} falhou: ${msg}`)
            }
          }

          this.events.emitToOrg(orgId, 'order:invalidate', {
            external_order_id: externalId ?? null,
            seller_id:         payload.user_id,
            topic:             payload.topic,
            kind,
            resource:          payload.resource,
            upserted,
            received_at:       new Date().toISOString(),
          })
          this.logger.log(`[ml-webhook] ${payload.topic} emit pra org=${orgId} id=${externalId} upserted=${upserted}`)
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
