import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { TikTokShopService } from './tiktok-shop.service'

/**
 * Reconciliação periódica do TikTok Shop. Rede de segurança do webhook
 * (TS-S1): se um evento se perder, o cron pega na próxima passada.
 * Idempotente (tudo upsert). importProducts pula o detalhe de produtos que já
 * têm imagem (só enriquece os novos). Gate: TIKTOK_SHOP_SYNC_CRON=off desliga.
 */
@Injectable()
export class TikTokShopSyncCron {
  private readonly logger = new Logger(TikTokShopSyncCron.name)

  constructor(private readonly svc: TikTokShopService) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async reconcile() {
    if (!this.svc.isConfigured() || process.env.TIKTOK_SHOP_SYNC_CRON === 'off') return
    let orgIds: string[]
    try {
      orgIds = await this.svc.getConnectedOrgIds()
    } catch (e) {
      this.logger.warn(`[tts.cron] listar orgs falhou: ${(e as Error).message}`)
      return
    }
    for (const orgId of orgIds) {
      try {
        const ord = await this.svc.importOrders(orgId)
        const prod = await this.svc.importProducts(orgId)
        if (ord.imported || prod.enriched) {
          this.logger.log(
            `[tts.cron] org=${orgId} pedidos=${ord.imported} produtos_novos_enriquecidos=${prod.enriched}`,
          )
        }
      } catch (e) {
        this.logger.warn(`[tts.cron] org=${orgId} falhou: ${(e as Error).message}`)
      }
    }
  }
}
