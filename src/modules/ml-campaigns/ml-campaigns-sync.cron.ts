import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { MlCampaignsSyncService } from './ml-campaigns-sync.service'

/**
 * Cron periódico de sync de campanhas ML. Antes era SÓ manual (botão
 * "sincronizar" na UI). Quando o ML abria campanhas novas (ex.: 06.06,
 * Menos tarifas de venda), o backend não detectava até alguém clicar —
 * caso real Vazzo 2026-05-13.
 *
 * Cadência:
 *  - hourly (cron @23 da hora): sync de todas as orgs conectadas
 *
 * Watchdog Promise.race 10min/org pra impedir 1 org travar todas.
 * Multi-conta natural: syncOrg() já itera getAllTokensForOrg internamente.
 */
@Injectable()
export class MlCampaignsSyncCron {
  private readonly logger = new Logger(MlCampaignsSyncCron.name)

  constructor(private readonly sync: MlCampaignsSyncService) {}

  /** :23 de cada hora — pega campanhas novas, mudanças de status, novos
   *  itens elegíveis em até ~1h após o ML expor. */
  @Cron('23 * * * *', { name: 'mlCampaignsHourlySync', timeZone: 'America/Sao_Paulo' })
  async hourlySync(): Promise<void> {
    const t0 = Date.now()
    this.logger.log(`[ml-campaigns.cron] iniciando hourly sync at ${new Date().toISOString()}`)

    // Lista todas as orgs com ML conectado
    const { data: connections } = await supabaseAdmin
      .from('ml_connections')
      .select('organization_id')
      .not('organization_id', 'is', null)
    const orgIds = [...new Set(((connections ?? []) as Array<{ organization_id: string }>).map(c => c.organization_id))]

    if (orgIds.length === 0) {
      this.logger.log('[ml-campaigns.cron] nenhuma org com ML conectado — pulando')
      return
    }

    let ok = 0
    let fail = 0
    for (const orgId of orgIds) {
      try {
        const result = await this.runWithTimeout(
          () => this.sync.syncOrg(orgId),
          10 * 60_000,
        )
        this.logger.log(
          `[ml-campaigns.cron] ✓ org=${orgId.slice(0,8)} ` +
          `campaigns=${result.campaigns_processed} items=${result.items_processed} ` +
          `duration=${result.duration_seconds}s`,
        )
        ok++
      } catch (err) {
        this.logger.error(`[ml-campaigns.cron] ✗ org=${orgId.slice(0,8)}: ${(err as Error).message}`)
        fail++
      }
    }

    this.logger.log(
      `[ml-campaigns.cron] hourly sync concluído: ${ok}/${orgIds.length} ok, ` +
      `${fail} falhas em ${Math.round((Date.now() - t0) / 1000)}s`,
    )
  }

  private async runWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Watchdog timeout (>${Math.round(timeoutMs / 60_000)}min)`)), timeoutMs),
      ),
    ])
  }
}
