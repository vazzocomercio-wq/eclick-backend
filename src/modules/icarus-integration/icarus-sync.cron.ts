import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { IcarusApiClient } from './icarus-api.client'
import { IcarusIntegrationService } from './icarus-integration.service'
import { IcarusCatalogService } from './icarus-catalog.service'
import { StockService } from '../stock/stock.service'

/**
 * Sessão 2026-05-18 — Crons de sincronização do fornecedor (Cinderella/Icarus).
 * O ERP não tem webhook, então polling é a única opção.
 *   - Estoque: a cada 15 min, incremental via estoque_v2 (cursor mo_number).
 *   - Preço/cadastro: a cada hora, incremental via /produtos?dtAlteracao.
 */

const STOCK_FIRST_CURSOR = 100       // estoque_v2 rejeita 0/1; 100 pega a 1ª página
const STOCK_PAGE_SIZE = 100          // estoque_v2 devolve no máximo 100 por chamada
const STOCK_MAX_PAGES_PER_RUN = 40   // teto por run (rate limit 60/min, sobra folga)
const RECONCILE_MAX_FIXES_PER_RUN = 500 // teto de ajustes por rodada (cada um propaga pros canais)

interface ActiveIntegration {
  id:              string
  organization_id: string
  supplier_id:     string
}

interface ReconcileRow {
  supplier_sku:         string
  product_id:           string
  partner_stock:        number | null
  last_stock_change_at: string | null
}

@Injectable()
export class IcarusSyncCron {
  private readonly log = new Logger(IcarusSyncCron.name)

  constructor(
    private readonly client: IcarusApiClient,
    private readonly integration: IcarusIntegrationService,
    private readonly catalog: IcarusCatalogService,
    private readonly stockService: StockService,
  ) {}

  /** Estoque — incremental via estoque_v2. Mantém partner_stock fresco.
   *  Após o incremental, roda a reconciliação saldo-a-saldo (ver método). */
  @Cron('*/15 * * * *', { name: 'icarus-stock-sync' })
  async syncStock(): Promise<void> {
    const integrations = await this.listActiveIntegrations()
    for (const integ of integrations) {
      try {
        await this.syncStockForIntegration(integ)
      } catch (e) {
        this.log.error(`[icarus-stock] supplier=${integ.supplier_id} falhou: ${(e as Error).message}`)
      }
      try {
        await this.reconcileStockForIntegration(integ)
      } catch (e) {
        this.log.error(`[icarus-reconcile] supplier=${integ.supplier_id} falhou: ${(e as Error).message}`)
      }
    }
  }

  /** Dispara a reconciliação sob demanda (endpoint do controller). */
  async reconcileNow(orgId: string, supplierId: string): Promise<{ checked: number; adjusted: number }> {
    const integrations = await this.listActiveIntegrations()
    const integ = integrations.find(i => i.organization_id === orgId && i.supplier_id === supplierId)
    if (!integ) return { checked: 0, adjusted: 0 }
    return this.reconcileStockForIntegration(integ)
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
        // Estoque físico no ledger (linha-mestre) + propagação pros canais.
        await supabaseAdmin
          .from('product_stock')
          .update({ quantity: stock, last_movement_at: now, updated_at: now })
          .eq('product_id', productId)
          .is('platform', null)
        await this.stockService
          .recalcAndPropagate(productId, 'icarus_stock_cron')
          .catch(e => this.log.warn(`[icarus-stock] recalc produto=${productId} falhou: ${(e as Error).message}`))
      }
    }

    await supabaseAdmin
      .from('supplier_integrations')
      .update({ config: { ...cfg, last_mo_number: maxMo } })
      .eq('id', integ.id)

    this.log.log(`[icarus-stock] supplier=${integ.supplier_id} → ${latest.size} SKUs atualizados, cursor=${maxMo}`)
  }

  /** Reconciliação saldo-a-saldo: re-asserta o ledger (linha-mestre do
   *  product_stock) a partir do partner_stock pra TODO produto vinculado.
   *
   *  Por que existe: o sync incremental só re-visita um SKU quando o Icarus
   *  gera movimento NOVO dele. SKU parado no fornecedor (ex.: zerado) nunca
   *  mais era corrigido, enquanto estornos locais de cancelamento re-criavam
   *  estoque fantasma — auditoria 2026-06-11 achou 205/1603 divergentes e
   *  anúncio ativo com fornecedor zerado (20406080C / CD251199/200).
   *
   *  Regras de segurança:
   *   • ledger > fornecedor → clampa pra BAIXO sempre (fantasma; o risco real
   *     é vender sem ter).
   *   • ledger < fornecedor → sobe, mas descontando as vendas locais líquidas
   *     posteriores ao último relatório do fornecedor — não re-adiciona
   *     unidade que acabou de vender e o Icarus ainda não processou.
   *  Cada ajuste grava movimento 'supplier_reconcile' (auditável na tela de
   *  movimentos) e dispara recalcAndPropagate (pausa/republica anúncios). */
  private async reconcileStockForIntegration(integ: ActiveIntegration): Promise<{ checked: number; adjusted: number }> {
    // 1. Todos os vínculos ativos com produto (paginado — pode passar de 1000).
    const links: ReconcileRow[] = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabaseAdmin
        .from('supplier_products')
        .select('supplier_sku, product_id, partner_stock, last_stock_change_at')
        .eq('supplier_id', integ.supplier_id)
        .eq('is_active', true)
        .not('product_id', 'is', null)
        .range(from, from + 999)
      if (error) throw new Error(`supplier_products: ${error.message}`)
      links.push(...((data ?? []) as ReconcileRow[]))
      if (!data || data.length < 1000) break
    }
    if (!links.length) return { checked: 0, adjusted: 0 }

    // 2. Linhas-mestre do ledger em chunks.
    const ledger = new Map<string, { id: string; quantity: number }>()
    const ids = [...new Set(links.map(l => l.product_id))]
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await supabaseAdmin
        .from('product_stock')
        .select('id, product_id, quantity')
        .in('product_id', ids.slice(i, i + 200))
        .is('platform', null)
      if (error) throw new Error(`product_stock: ${error.message}`)
      for (const r of data ?? []) {
        ledger.set(r.product_id as string, { id: r.id as string, quantity: Number(r.quantity) || 0 })
      }
    }

    // 3. Divergências + ajustes.
    let adjusted = 0
    for (const link of links) {
      if (adjusted >= RECONCILE_MAX_FIXES_PER_RUN) {
        this.log.warn(`[icarus-reconcile] teto de ${RECONCILE_MAX_FIXES_PER_RUN} ajustes atingido — restante fica pra próxima rodada`)
        break
      }
      if (link.partner_stock == null) continue // fornecedor nunca reportou — nada a assertar
      const row = ledger.get(link.product_id)
      if (!row) continue
      const target = Math.max(0, Math.round(Number(link.partner_stock) || 0))
      if (row.quantity === target) continue

      let newQty = target
      if (row.quantity < target) {
        // Subida: desconta vendas locais líquidas APÓS o último relatório do
        // fornecedor (provavelmente ainda não processadas no Icarus).
        const since = link.last_stock_change_at
        if (!since) continue
        const { data: movs } = await supabaseAdmin
          .from('stock_movements')
          .select('movement_type, quantity')
          .eq('product_id', link.product_id)
          .eq('reference_type', 'ml_order')
          .gt('created_at', since)
        let net = 0
        for (const m of movs ?? []) {
          if (m.movement_type === 'sale') net += Number(m.quantity) || 0
          else if (m.movement_type === 'sale_reversal') net -= Number(m.quantity) || 0
        }
        newQty = Math.max(0, target - Math.max(0, net))
        if (newQty <= row.quantity) continue // sem ganho real — não mexe
      }

      const now = new Date().toISOString()
      const { error: upErr } = await supabaseAdmin
        .from('product_stock')
        .update({ quantity: newQty, last_movement_at: now, updated_at: now })
        .eq('id', row.id)
      if (upErr) {
        this.log.warn(`[icarus-reconcile] update sku=${link.supplier_sku} falhou: ${upErr.message}`)
        continue
      }
      await supabaseAdmin.from('stock_movements').insert({
        product_id:     link.product_id,
        stock_id:       row.id,
        movement_type:  'supplier_reconcile',
        quantity:       Math.abs(newQty - row.quantity),
        balance_after:  newQty,
        reference_type: 'icarus_reconcile',
        reference_id:   link.supplier_sku,
        notes:          `Reconciliação fornecedor: ledger ${row.quantity} → ${newQty} (fornecedor=${target})`,
      })
      await this.stockService
        .recalcAndPropagate(link.product_id, 'icarus_reconcile')
        .catch(e => this.log.warn(`[icarus-reconcile] recalc produto=${link.product_id} falhou: ${(e as Error).message}`))
      adjusted++
    }

    if (adjusted > 0) {
      this.log.log(`[icarus-reconcile] supplier=${integ.supplier_id} → ${links.length} conferidos, ${adjusted} corrigidos`)
    }
    return { checked: links.length, adjusted }
  }

  private yyyymmdd(d: Date): string {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}${m}${day}`
  }
}
