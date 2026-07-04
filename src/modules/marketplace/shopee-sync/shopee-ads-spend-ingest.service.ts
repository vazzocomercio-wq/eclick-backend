import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import * as XLSX from 'xlsx'
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

  /** Importa o RELATÓRIO de Ads exportado do Seller Center (xlsx/csv) →
   *  platform_charges. Caminho manual: a Shopee não libera mais o módulo Ads
   *  da API pro app, e as recargas não passam pela carteira do vendedor.
   *
   *  Aceita o relatório com DADOS DIÁRIOS (coluna de data + despesas; com ou
   *  sem coluna de anúncio/campanha). Idempotente por dia(+campanha):
   *  re-upload do mesmo período atualiza os valores, não duplica. */
  async ingestReport(orgId: string, buf: Buffer, filename: string): Promise<{
    rows_parsed: number; charges_upserted: number; total: number
    period_from: string | null; period_to: string | null; skipped: number
  }> {
    let wb: XLSX.WorkBook
    try {
      wb = XLSX.read(buf, { type: 'buffer', cellDates: false, cellNF: false, cellText: false })
    } catch {
      throw new BadRequestException('Arquivo inválido — envie o .xlsx ou .csv exportado do Seller Center (Anúncios Shopee).')
    }
    const sheet = wb.Sheets[wb.SheetNames[0]]
    if (!sheet) throw new BadRequestException('Planilha vazia.')
    const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null }) as unknown[][]

    // Acha a linha de cabeçalho: precisa ter coluna de data E de despesa.
    const norm = (v: unknown) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
    const isDateHeader  = (s: string) => /^data\b|^date\b|^dia\b/.test(s)
    const isSpendHeader = (s: string) => /despes|gasto|expense|custo total|spend/.test(s)
    const isGmvHeader   = (s: string) => /gmv|receita|vendas \(|sales/.test(s)
    const isNameHeader  = (s: string) => /nome do anuncio|nome do produto|anuncio|campanha|ad name|campaign/.test(s)
    let headerIdx = -1, dateCol = -1, spendCol = -1, gmvCol = -1, nameCol = -1
    for (let i = 0; i < Math.min(grid.length, 20); i++) {
      const cells = (grid[i] ?? []).map(norm)
      const d = cells.findIndex(isDateHeader)
      const s = cells.findIndex(isSpendHeader)
      if (d >= 0 && s >= 0) {
        headerIdx = i; dateCol = d; spendCol = s
        gmvCol  = cells.findIndex(isGmvHeader)
        nameCol = cells.findIndex(isNameHeader)
        break
      }
    }
    if (headerIdx < 0) {
      throw new BadRequestException(
        'Não achei as colunas de Data e Despesas. Exporte o relatório de Anúncios com dados DIÁRIOS ' +
        '(Seller Center → Anúncios → Dados → Exportar, período com quebra por dia).',
      )
    }

    // Datas: serial do Excel, "DD/MM/YYYY", "DD-MM-YYYY" ou ISO.
    const toIsoDate = (v: unknown): string | null => {
      if (v == null || v === '') return null
      if (typeof v === 'number' && v > 25569 && v < 80000) {           // serial Excel
        return new Date(Math.round((v - 25569) * 86400 * 1000)).toISOString().slice(0, 10)
      }
      const s = String(v).trim()
      let m = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})/)
      if (m) return `${m[3]}-${m[2]}-${m[1]}`
      m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
      if (m) return `${m[1]}-${m[2]}-${m[3]}`
      return null
    }
    const toMoney = (v: unknown): number => {
      if (typeof v === 'number') return v
      const s = String(v ?? '').replace(/[^\d,.-]/g, '')
      if (!s) return 0
      // "1.234,56" (pt-BR) → 1234.56 | "1234.56" → direto
      const br = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s
      return Number(br) || 0
    }
    const slug = (v: unknown) => norm(v).replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'total'

    const nowIso = new Date().toISOString()
    const byKey = new Map<string, Record<string, unknown>>()
    let parsed = 0, skipped = 0
    for (let i = headerIdx + 1; i < grid.length; i++) {
      const row = grid[i] ?? []
      const date = toIsoDate(row[dateCol])
      const spend = toMoney(row[spendCol])
      if (!date) { if (row.some(c => c != null && c !== '')) skipped++; continue }
      parsed++
      if (spend <= 0) continue
      const name = nameCol >= 0 ? String(row[nameCol] ?? '').trim() || null : null
      const key = `report:${date}:${nameCol >= 0 ? slug(name) : 'total'}`
      const prev = byKey.get(key)
      const amount = Math.round(((prev ? Number(prev.amount) : 0) + spend) * 100) / 100
      byKey.set(key, {
        organization_id: orgId, platform: 'shopee', charge_category: 'ads',
        raw_subtype: 'ads_report', detail_type: 'charge',
        amount, external_order_id: null, charge_date: date, period_key: date.slice(0, 7),
        source: 'shopee_ads_report', source_detail_id: key, currency: 'BRL',
        raw: { name, gmv: gmvCol >= 0 ? toMoney(row[gmvCol]) : null, file: filename },
        fetched_at: nowIso,
      })
    }
    const charges = [...byKey.values()]
    let upserted = 0
    for (let i = 0; i < charges.length; i += 500) {
      const batch = charges.slice(i, i + 500)
      const { error } = await supabaseAdmin
        .from('platform_charges')
        .upsert(batch, { onConflict: 'organization_id,source,source_detail_id', ignoreDuplicates: false })
      if (error) throw new BadRequestException(`Falha ao gravar: ${error.message}`)
      upserted += batch.length
    }
    const dates = charges.map(c => String(c.charge_date)).sort()
    const total = Math.round(charges.reduce((s, c) => s + Number(c.amount), 0) * 100) / 100
    this.logger.log(`[shopee.ads.report] org=${orgId.slice(0, 8)} file="${filename}" rows=${parsed} charges=${upserted} total=R$${total}`)
    return {
      rows_parsed: parsed, charges_upserted: upserted, total,
      period_from: dates[0] ?? null, period_to: dates[dates.length - 1] ?? null, skipped,
    }
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
