import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { PricingAiService } from '../pricing-ai/pricing-ai.service'
import { AdsCampaignsService } from '../ads-campaigns/ads-campaigns.service'
import { SocialContentService } from '../social-content/social-content.service'
import { ActiveBridgeClient } from './active-bridge.client'
import type {
  StoreAutomationAction,
  ProposedAction,
  ProposedActionType,
} from './store-automation.types'

/**
 * Onda 4 / A3 — Executor das ações aprovadas.
 *
 * Quando o lojista aprova (ou auto-execute trigger dispara), este service
 * pega o proposed_action e roteia pro service correto:
 *   - adjust_price        → PricingAiService.applyToProduct (via approve)
 *   - create_campaign     → AdsCampaignsService.generateForProduct
 *   - pause_campaign      → AdsCampaignsService.pause
 *   - generate_content    → SocialContentService.generateBatch
 *   - send_recovery       → ActiveBridgeClient.triggerCartRecovery
 *   - notify_lojista      → ActiveBridgeClient.notifyLojista
 *   - restock_alert       → notifyLojista (não há ação direta)
 *   - enrich_products     → marca ai_enrichment_pending=true (worker pega)
 *
 * Resultado salvo em execution_result da action.
 */
@Injectable()
export class StoreAutomationExecutor {
  private readonly logger = new Logger(StoreAutomationExecutor.name)

  constructor(
    private readonly pricingAi:  PricingAiService,
    private readonly ads:        AdsCampaignsService,
    private readonly social:     SocialContentService,
    private readonly bridge:     ActiveBridgeClient,
  ) {}

  /** Executa a ação. Caller já mudou status pra 'approved' ou
   *  'auto_executed'. Aqui marcamos 'executing' → 'completed' ou 'failed'. */
  async execute(action: StoreAutomationAction): Promise<{
    success: boolean
    result:  Record<string, unknown>
  }> {
    const proposed = action.proposed_action as ProposedAction
    if (!proposed?.type) {
      throw new BadRequestException('proposed_action.type ausente')
    }

    await this.markStatus(action.id, 'executing')

    try {
      const result = await this.dispatch(action.organization_id, proposed)
      await this.markCompleted(action.id, result)
      return { success: true, result }
    } catch (e) {
      const msg = (e as Error).message ?? 'erro'
      this.logger.warn(`[executor] ${action.id} falhou: ${msg}`)
      await this.markFailed(action.id, msg)
      return { success: false, result: { error: msg } }
    }
  }

  private async dispatch(orgId: string, p: ProposedAction): Promise<Record<string, unknown>> {
    const t = p.type as ProposedActionType

    switch (t) {
      case 'adjust_price': {
        if (!p.product_id || p.new_price == null) {
          throw new BadRequestException('product_id e new_price obrigatórios')
        }
        // Atualiza preço direto na tabela products
        const { error } = await supabaseAdmin
          .from('products')
          .update({ price: p.new_price })
          .eq('id', p.product_id)
          .eq('organization_id', orgId)
        if (error) throw new BadRequestException(`Erro: ${error.message}`)
        return { product_id: p.product_id, new_price: p.new_price, applied: true }
      }

      case 'create_campaign': {
        if (!p.product_id) throw new BadRequestException('product_id obrigatório')
        // Usa userId placeholder do executor (system) — o owner real fica
        // no products.organization_members
        const r = await this.ads.generateForProduct({
          orgId,
          userId:    '00000000-0000-0000-0000-000000000000',  // system
          productId: p.product_id,
          platform:  (p.platform as 'meta' | 'google' | 'tiktok' | 'mercado_livre_ads') ?? 'meta',
          objective: (p.objective as 'traffic' | 'conversions' | 'engagement' | 'awareness' | 'catalog_sales' | 'leads') ?? 'conversions',
        })
        return {
          campaign_id: r.campaign.id,
          name:        r.campaign.name,
          cost_usd:    r.cost_usd,
        }
      }

      case 'pause_campaign': {
        if (!p.campaign_id) throw new BadRequestException('campaign_id obrigatório')
        await this.ads.pause(p.campaign_id, orgId)
        return { campaign_id: p.campaign_id, status: 'paused' }
      }

      case 'generate_content': {
        if (!p.product_ids?.length) throw new BadRequestException('product_ids obrigatório')
        if (!p.channels?.length)    throw new BadRequestException('channels obrigatório')
        const r = await this.social.generateBatch({
          orgId,
          userId:     '00000000-0000-0000-0000-000000000000',
          productIds: p.product_ids,
          channels:   p.channels as Parameters<SocialContentService['generateBatch']>[0]['channels'],
        })
        return { generated: r.generated, failed: r.failed, cost_usd: r.cost_usd }
      }

      case 'send_recovery': {
        const r = await this.bridge.triggerCartRecovery({
          organization_id: orgId,
          cart_ids:        p.cart_ids,
          template_key:    p.template,
        })
        return { ...r }
      }

      case 'notify_lojista':
      case 'restock_alert': {
        const message = p.message
          ?? (t === 'restock_alert'
              ? `Estoque crítico: produto ${p.product_id ?? ''} com ${p.current_stock ?? 0} unidades. Reabasteça ${p.suggested_quantity ?? 0} un.`
              : 'Notificação automática')
        const r = await this.bridge.notifyLojista({
          organization_id: orgId,
          message,
          severity:        (t === 'restock_alert' ? 'high' : 'medium'),
        })
        return { ...r }
      }

      case 'enrich_products': {
        if (!p.product_ids?.length) throw new BadRequestException('product_ids obrigatório')
        const { error } = await supabaseAdmin
          .from('products')
          .update({ ai_enrichment_pending: true })
          .in('id', p.product_ids)
          .eq('organization_id', orgId)
        if (error) throw new BadRequestException(`Erro: ${error.message}`)
        return { marked_for_enrichment: p.product_ids.length }
      }

      case 'create_collection':
      case 'create_kit': {
        // Sprint 5/6 implementam. Por ora, deixa pendente como anotação.
        return {
          deferred: true,
          note:     `${t} será implementado em sprint futura (kits/collections)`,
        }
      }

      default:
        throw new BadRequestException(`Tipo de ação não suportado: ${t}`)
    }
  }

  private async markStatus(id: string, status: 'executing' | 'completed' | 'failed'): Promise<void> {
    await supabaseAdmin
      .from('store_automation_actions')
      .update({ status })
      .eq('id', id)
  }

  private async markCompleted(id: string, result: Record<string, unknown>): Promise<void> {
    await supabaseAdmin
      .from('store_automation_actions')
      .update({
        status:           'completed',
        executed_at:      new Date().toISOString(),
        execution_result: result,
      })
      .eq('id', id)
  }

  private async markFailed(id: string, message: string): Promise<void> {
    await supabaseAdmin
      .from('store_automation_actions')
      .update({
        status:           'failed',
        executed_at:      new Date().toISOString(),
        execution_result: { error: message },
      })
      .eq('id', id)
  }
}
