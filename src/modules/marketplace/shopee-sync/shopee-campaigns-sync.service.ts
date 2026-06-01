import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { MarketplaceService } from '../marketplace.service'
import { ShopeeAdapter } from '../adapters/shopee.adapter'
import { ShopeeProductSyncService } from './shopee-product-sync.service'
import { ShopeeCampaignsService } from '../shopee-campaigns/shopee-campaigns.service'

/** F18 F1.4 sync — campanhas reais da loja (Campaign Center).
 *
 *  Puxa vouchers (ongoing+upcoming) + flash sales (upcoming+ongoing) via
 *  ShopeeAdapter.getCampaigns e substitui as campanhas sincronizadas em
 *  shopee.campaigns (replaceSyncedCampaigns: delete external_id NOT NULL +
 *  insert — preserva demo/manual, sem migration).
 *
 *  Sem spend/GMV (voucher/flash_sale não expõem — só módulo Ads, escopo à
 *  parte) → revenue/cost/orders = 0; ROI fica "—" na UI. Resiliente: se um
 *  módulo der error_permission, o outro segue (vai pra errors[]).
 *
 *  Reusa ensureFreshToken do ProductSync (refresh-on-demand). */
@Injectable()
export class ShopeeCampaignsSyncService {
  private readonly logger = new Logger(ShopeeCampaignsSyncService.name)

  constructor(
    private readonly mp:          MarketplaceService,
    private readonly adapter:     ShopeeAdapter,
    private readonly productSync: ShopeeProductSyncService,
    private readonly campaigns:   ShopeeCampaignsService,
  ) {}

  async syncCampaigns(orgId: string): Promise<{
    shop_id:     number
    vouchers:    number
    flash_sales: number
    total:       number
    errors:      string[]
  }> {
    const resolved = await this.mp.resolve(orgId, 'shopee')
    if (!resolved) throw new NotFoundException('Loja Shopee não conectada nesta organização')

    const conn = await this.productSync.ensureFreshToken(resolved.conn)
    if (!conn.shop_id) throw new NotFoundException('Conexão Shopee sem shop_id')
    const shopId = conn.shop_id

    const result = await this.adapter.getCampaigns(conn)
    await this.campaigns.replaceSyncedCampaigns(orgId, shopId, result.campaigns)

    const vouchers    = result.campaigns.filter(c => c.kind === 'voucher').length
    const flash_sales = result.campaigns.filter(c => c.kind === 'flash_sale').length

    this.logger.log(
      `[shopee.campaigns.sync] org=${orgId} shop=${shopId} ` +
      `vouchers=${vouchers} flash=${flash_sales} errors=${result.errors.length}`,
    )
    return {
      shop_id: shopId, vouchers, flash_sales,
      total: result.campaigns.length, errors: result.errors,
    }
  }
}
