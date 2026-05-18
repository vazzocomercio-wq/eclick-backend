import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { IcarusApiClient } from './icarus-api.client'
import { IcarusIntegrationService } from './icarus-integration.service'
import { IcarusCatalogService } from './icarus-catalog.service'

/**
 * Sessão 2026-05-18 — Crons de sincronização do fornecedor (Cinderella/Icarus).
 * O ERP não tem webhook, então polling é a única opção.
 *   - Estoque: a cada 15 min, incremental via estoque_v2 (cursor mo_number).
 *   - Preço/cadastro: a cada hora, incremental via /produtos?dtAlteracao.
 */

const STOCK_FIRST_CURSOR = 100       // estoque_v2 rejeita 0/1; 100 pega a 1ª página
const STOCK_PAGE_SIZE = 100          // estoque_v2 devolve no máximo 100 por chamada
const STOCK_MAX_PAGES_PER_RUN = 40   // teto por run (rate limit 60/min, sobra folga)

interface ActiveIntegration {
  id:              string
  organization_id: string
  supplier_id:     string
}

@Injectable()
export class IcarusSyncCron {
  private readonly log = new Logger(IcarusSyncCron.name)

  constructor(
    private readonly client: IcarusApiClient,
    private readonly integration: IcarusIntegrationService,
    private readonly catalog: IcarusCatalogService,
  ) {}

  /** Estoque — incremental via estoque_v2. Mantém partner_stock fresco. */
  @Cron('*/15 * * * *', { name: 'icarus-stock-sync' })
  async syncStock(): Promise<void> {
    const integrations = await this.listActiveIntegrations()
    for (const integ of integrations) {
      try {
        await this.syncStockForIntegration(integ)
      } catch (e) {
        this.log.error(`[icarus-stock] supplier=${integ.supplier_id} falhou: ${(e as Error).message}`)
      }
    }
  }

  /** Preço/cadastro — incremental via /produtos?dtAlteracao + recálculo de custo. */
  @Cron('0 * * * *', { name: 'icarus-price-sync' })
  async syncPrices(): Promise<void> {
    const integrations = await this.listActiveIntegrations()
    // Janela de 36h pra sobrepor com folga (o cron roda de hora em hora).
    const dt = this.yyyymmdd(new Date(Date.now() - 36 * 3600_000))
    for (const integ of integrations) {
      try {
        await this.catalog.pullCatalog(integ.organization_id, integ.supplier_id, dt)
        const recomputed = await this.catalog.recomputeSupplierCosts(integ.organization_id, integ.supplier_id)
        if (recomputed > 0) {
          this.log.log(`[icarus-price] supplier=${integ.supplier_id} → ${recomputed} custos recalculados`)
        }
      } catch (e) {
        this.log.error(`[icarus-price] supplier=${integ.supplier_id} falhou: ${(e as Error).message}`)
      }
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private async listActiveIntegrations(): Promise<ActiveIntegration[]> {
    const { data } = await supabaseAdmin
      .from('supplier_integrations')
      .select('id, organization_id, supplier_id')
      .eq('integration_type', 'icarus')
      .eq('is_active', true)
    return (data ?? []) as ActiveIntegration[]
  }

  private async syncStockForIntegration(integ: ActiveIntegration): Promise<void> {
    const tok = await this.integration.getDecryptedToken(integ.organization_id, integ.supplier_id)
    if (!tok) return
    const clientConfig = this.integration.buildClientConfig(tok.config)

    const cfg = (tok.config ?? {}) as Record<string, unknown>
    const startCursor = Math.max(Number(cfg.last_mo_number) || 0, STOCK_FIRST_CURSOR)

    // pt_code → último saldo visto no run (movimentos mais novos sobrescrevem)
    const latest = new Map<string, number>()
    let next = startCursor
    let maxMo = startCursor - 1
    let pages = 0

    while (pages < STOCK_MAX_PAGES_PER_RUN) {
      const res = await this.client.listStockV2(tok.access_token, next, clientConfig)
      const movs = res.data ?? []
      if (movs.length === 0) break
      for (const m of movs) {
        if (m.pt_code) latest.set(String(m.pt_code).trim(), Number(m.pt_qtd) || 0)
        const mo = Number(m.mo_number) || 0
        if (mo > maxMo) maxMo = mo
      }
      pages++
      if (movs.length < STOCK_PAGE_SIZE) break
      next = maxMo + 1
    }

    if (latest.size === 0) return

    // Mapa supplier_sku -> product_id, pra refletir o estoque também no produto.
    const { data: spRows } = await supabaseAdmin
      .from('supplier_products')
      .select('supplier_sku, product_id')
      .eq('supplier_id', integ.supplier_id)
    const skuToProduct = new Map<string, string>(
      (spRows ?? [])
        .filter(r => r.supplier_sku && r.product_id)
        .map((r): [string, string] => [r.supplier_sku as string, r.product_id as string]),
    )

    const now = new Date().toISOString()
    for (const [code, qty] of latest) {
      const stock = Math.max(0, Math.round(qty))
      await supabaseAdmin
        .from('supplier_catalog_items')
        .update({ stock: qty, updated_at: now })
        .eq('supplier_id', integ.supplier_id)
        .eq('external_code', code)
      await supabaseAdmin
        .from('supplier_products')
        .update({ partner_stock: qty, last_stock_change_at: now, updated_at: now })
        .eq('supplier_id', integ.supplier_id)
        .eq('supplier_sku', code)
      const productId = skuToProduct.get(code)
      if (productId) {
        await supabaseAdmin
          .from('products')
          .update({ stock, updated_at: now })
          .eq('id', productId)
          .eq('organization_id', integ.organization_id)
      }
    }

    await supabaseAdmin
      .from('supplier_integrations')
      .update({ config: { ...cfg, last_mo_number: maxMo } })
      .eq('id', integ.id)

    this.log.log(`[icarus-stock] supplier=${integ.supplier_id} → ${latest.size} SKUs atualizados, cursor=${maxMo}`)
  }

  private yyyymmdd(d: Date): string {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}${m}${day}`
  }
}
