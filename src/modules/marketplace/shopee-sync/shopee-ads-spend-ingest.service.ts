import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { MarketplaceService } from '../marketplace.service'
import { ShopeeAdapter } from '../adapters/shopee.adapter'
import { ShopeeProductSyncService } from './shopee-product-sync.service'
import { ShopeeCampaignsSyncService } from './shopee-campaigns-sync.service'

/** Gasto REAL de Shopee Ads → ledger `platform_charges` (categoria 'ads').
 *
 *  Fonte: módulo Ads da Open Platform (escopo 105 — precisa estar habilitado
 *  no app; sem ele a API devolve error_api_permission e o ingest reporta o
 *  erro sem quebrar). Grava o gasto POR DIA por campanha (idempotente por
 *  shop+campanha+dia) — a DRE/Central de Resultado passa a descontar o Ads
 *  da Shopee automaticamente, como já faz com ML e TikTok.
 *
 *  Cron diário 05:10 também re-sincroniza as campanhas (shopee.campaigns
 *  ficava parada — só sincronizava em clique manual ou promo write). */
@Injectable()
export class ShopeeAdsSpendIngestService {
  private readonly logger = new Logger(ShopeeAdsSpendIngestService.name)

  constructor(
    private readonly mp:            MarketplaceService,
    private readonly adapter:       ShopeeAdapter,
    private readonly productSync:   ShopeeProductSyncService,
    private readonly campaignsSync: ShopeeCampaignsSyncService,
  ) {}

  /** Ingere o gasto diário de Ads (janela 30d) de todas as lojas da org. */
  async ingest(orgId: string): Promise<{
    shops: Array<{ shop_id: number; days: number; total: number; errors: string[] }>
  }> {
    const all = await this.mp.resolveAll(orgId, 'shopee')
    if (!all.length) throw new NotFoundException('Loja Shopee não conectada nesta organização')
    const shops: Array<{ shop_id: number; days: number; total: number; errors: string[] }> = []

    for (const { conn: c0 } of all) {
      try {
        const conn = await this.productSync.ensureFreshToken(c0)
        if (!conn.shop_id) continue
        const shopId = conn.shop_id
        const { rows, errors } = await this.adapter.getAdsDailySpend(conn, 30)

        const nowIso = new Date().toISOString()
        const charges = rows.map(r => ({
          organization_id: orgId, platform: 'shopee', charge_category: 'ads',
          raw_subtype: 'ads_daily_spend', detail_type: 'charge',
          amount: Math.round(r.expense * 100) / 100,
          external_order_id: null, charge_date: r.date, period_key: r.date.slice(0, 7),
          source: 'shopee_ads', source_detail_id: `${shopId}:${r.campaign_id}:${r.date}`,
          currency: 'BRL',
          raw: { campaign_id: r.campaign_id, name: r.name, gmv: r.gmv },
          fetched_at: nowIso,
        }))
        let upserted = 0
        for (let i = 0; i < charges.length; i += 500) {
          const batch = charges.slice(i, i + 500)
          const { error } = await supabaseAdmin
            .from('platform_charges')
            .upsert(batch, { onConflict: 'organization_id,source,source_detail_id', ignoreDuplicates: false })
          if (error) this.logger.error(`[shopee.ads] upsert batch ${i}: ${error.message}`)
          else upserted += batch.length
        }
        const total = Math.round(rows.reduce((s, r) => s + r.expense, 0) * 100) / 100
        this.logger.log(`[shopee.ads] org=${orgId.slice(0, 8)} shop=${shopId} dias=${upserted} gasto30d=R$${total} errors=${errors.length}${errors.length ? ` (${errors[0]})` : ''}`)
        shops.push({ shop_id: shopId, days: upserted, total, errors })
      } catch (e: unknown) {
        this.logger.warn(`[shopee.ads] shop=${c0.shop_id} falhou: ${(e as Error)?.message}`)
        shops.push({ shop_id: Number(c0.shop_id ?? 0), days: 0, total: 0, errors: [(e as Error)?.message ?? 'erro'] })
      }
    }
    return { shops }
  }

  /** Cron diário 05:10 — re-sincroniza campanhas + ingere gasto de Ads de
   *  toda org com loja Shopee conectada. */
  @Cron('10 5 * * *', { name: 'shopeeAdsSpendDaily' })
  async cronDaily(): Promise<void> {
    const { data } = await supabaseAdmin
      .from('marketplace_connections')
      .select('organization_id')
      .eq('platform', 'shopee')
      .eq('status', 'connected')
    const orgIds = [...new Set((data ?? []).map(r => (r as { organization_id: string }).organization_id))]
    for (const orgId of orgIds) {
      // campanhas primeiro (tela fresca), depois o ledger de gasto
      await this.campaignsSync.syncCampaigns(orgId).catch(e =>
        this.logger.warn(`[shopee.ads] cron campanhas org=${orgId.slice(0, 8)}: ${e instanceof Error ? e.message : e}`))
      await this.ingest(orgId).catch(e =>
        this.logger.warn(`[shopee.ads] cron ingest org=${orgId.slice(0, 8)}: ${e instanceof Error ? e.message : e}`))
    }
  }
}
