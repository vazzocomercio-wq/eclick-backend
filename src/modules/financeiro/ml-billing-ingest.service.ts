import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'

const ML_BASE = 'https://api.mercadolibre.com'

/** detail_sub_type (ML) → categoria de negócio normalizada (platform_charges). */
const CATEGORY_BY_SUBTYPE: Record<string, string> = {
  // comissão de venda
  CVVML: 'comissao', CV: 'comissao', BVVML: 'comissao', BV: 'comissao',
  // cobrança / recebimento no Mercado Pago
  CVVPRC: 'cobranca', CVVFNU: 'cobranca', BVVPRC: 'cobranca', BVVFNU: 'cobranca',
  // parcelamento
  CFONPN: 'parcelamento', CVVFN: 'parcelamento', BFONPN: 'parcelamento', BVVFN: 'parcelamento',
  // frete / envios
  CXDE: 'frete', CDSB: 'frete', CXDI: 'frete', CDSDB: 'frete', CXDED: 'frete', CXDID: 'frete', CPYE: 'frete',
  BXDE: 'frete', BDSB: 'frete', BXDI: 'frete', BDSDB: 'frete', BXDED: 'frete', BPYE: 'frete',
  // publicidade
  PADS: 'ads', CDLIT: 'ads', BPAD: 'ads',
  // impostos
  CDIFAL: 'imposto',
}

interface BillingLine {
  charge_info?: {
    detail_id?: number | string
    detail_type?: string          // CHARGE | BONUS
    detail_sub_type?: string
    detail_amount?: number
    transaction_detail?: string
    creation_date_time?: string
  }
  sales_info?: Array<{ order_id?: number | string; sale_date_time?: string; transaction_amount?: number }>
  shipping_info?: { shipping_id?: string }
}

/**
 * Ingere a FATURA real do ML (/billing/integration/.../details) para
 * platform_charges — a fonte da verdade do custo por plataforma. Idempotente
 * (upsert por org+source+detail_id). Re-bucketa por MÊS CALENDÁRIO via
 * sale_date_time (não o período 30→29 da fatura). Multi-conta (fan-out tokens).
 */
@Injectable()
export class MlBillingIngestService {
  private readonly logger = new Logger(MlBillingIngestService.name)

  constructor(private readonly ml: MercadolivreService) {}

  /** Lista as N chaves de período mais recentes (ex '2026-05-01'). */
  private async listRecentPeriodKeys(token: string, n: number): Promise<string[]> {
    try {
      const { data } = await axios.get(
        `${ML_BASE}/billing/integration/monthly/periods`,
        { headers: { Authorization: `Bearer ${token}`, 'x-version': '2' }, params: { group: 'ML', document_type: 'BILL', offset: 0, limit: n }, timeout: 15_000 },
      )
      const results = (data?.results ?? []) as Array<{ key?: string }>
      return results.map(r => r.key).filter((k): k is string => !!k)
    } catch (e) {
      this.logger.warn(`[ml-billing] listPeriods falhou: ${(e as Error).message}`)
      return []
    }
  }

  /** Ingere UM período (todas as contas ML da org). Idempotente. */
  async ingestPeriod(orgId: string, periodKey: string): Promise<{ upserted: number; by_category: Record<string, number> }> {
    let tokens: Array<{ token: string; sellerId: number }>
    try {
      tokens = await this.ml.getAllTokensForOrg(orgId)
    } catch {
      return { upserted: 0, by_category: {} }
    }

    const rows: Record<string, unknown>[] = []
    const byCat: Record<string, number> = {}

    for (const { token } of tokens) {
      let offset = 0, total = Infinity, pages = 0
      while (offset < total && pages < 60) {
        let data: { total?: number; results?: BillingLine[] } | null = null
        // Retry paciente: a API de faturamento tem rate-limit agressivo (429).
        // Backoff exponencial (3s→24s, 8 tentativas) pra a página eventualmente
        // passar — quebrar a paginação no meio perderia o resto do mês.
        for (let attempt = 0; attempt < 8; attempt++) {
          try {
            const res = await axios.get(
              `${ML_BASE}/billing/integration/periods/key/${periodKey}/group/ML/details`,
              { headers: { Authorization: `Bearer ${token}`, 'x-version': '2' }, params: { document_type: 'BILL', offset, limit: 1000 }, timeout: 25_000 },
            )
            data = res.data
            break
          } catch (e) {
            const status = (e as { response?: { status?: number } })?.response?.status
            const wait = Math.min(3000 * Math.pow(1.6, attempt), 24_000)
            if (status === 429 || status === undefined || (status >= 500)) {
              this.logger.warn(`[ml-billing] ${periodKey} offset=${offset} status=${status ?? 'net'} retry ${attempt + 1}/8 em ${Math.round(wait / 1000)}s`)
              await new Promise(r => setTimeout(r, wait))
              continue
            }
            this.logger.warn(`[ml-billing] ${periodKey} offset=${offset} falhou def: ${(e as Error).message}`)
            break
          }
        }
        if (!data?.results) break
        total = data.total ?? 0
        for (const line of data.results) {
          const ci = line.charge_info
          if (!ci?.detail_id) continue
          const subtype = ci.detail_sub_type ?? '(null)'
          const category = CATEGORY_BY_SUBTYPE[subtype] ?? 'outros'
          const detailType = ci.detail_type === 'BONUS' ? 'credit' : 'charge'
          const amount = Math.round(Math.abs(Number(ci.detail_amount ?? 0)) * 100) / 100
          const sale = (line.sales_info ?? [])[0]
          const chargeDate = (sale?.sale_date_time ?? ci.creation_date_time ?? `${periodKey}T00:00:00`).slice(0, 10)
          rows.push({
            organization_id: orgId,
            platform: 'mercadolivre',
            charge_category: category,
            raw_subtype: subtype,
            detail_type: detailType,
            amount,
            external_order_id: sale?.order_id != null ? String(sale.order_id) : null,
            charge_date: chargeDate,
            period_key: periodKey,
            source: 'ml_billing',
            source_detail_id: String(ci.detail_id),
            currency: 'BRL',
            raw: { transaction_detail: ci.transaction_detail ?? null, shipping_id: line.shipping_info?.shipping_id ?? null },
            fetched_at: new Date().toISOString(),
          })
          const signed = detailType === 'credit' ? -amount : amount
          byCat[category] = Math.round(((byCat[category] ?? 0) + signed) * 100) / 100
        }
        offset += 1000; pages++
        // A API de faturamento limita ~5 req/janela curta → espaça 2,5s entre
        // páginas pra a janela recuperar e a paginação não perder o tail.
        await new Promise(r => setTimeout(r, 2500))
      }
    }

    // Upsert em lotes (idempotente por org+source+detail_id)
    let upserted = 0
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500)
      const { error } = await supabaseAdmin
        .from('platform_charges')
        .upsert(batch, { onConflict: 'organization_id,source,source_detail_id', ignoreDuplicates: false })
      if (error) this.logger.error(`[ml-billing] upsert ${periodKey} batch ${i}: ${error.message}`)
      else upserted += batch.length
    }
    this.logger.log(`[ml-billing] org=${orgId.slice(0, 8)} ${periodKey}: ${upserted} linhas, cats=${JSON.stringify(byCat)}`)
    return { upserted, by_category: byCat }
  }

  /** Ingere os N períodos mais recentes de uma org (default 2: aberto + anterior). */
  async ingestRecent(orgId: string, n = 2): Promise<{ periods: string[]; upserted: number }> {
    let tokens: Array<{ token: string; sellerId: number }>
    try { tokens = await this.ml.getAllTokensForOrg(orgId) } catch { return { periods: [], upserted: 0 } }
    if (tokens.length === 0) return { periods: [], upserted: 0 }
    const keys = await this.listRecentPeriodKeys(tokens[0].token, n)
    let upserted = 0
    for (const k of keys) {
      const r = await this.ingestPeriod(orgId, k)
      upserted += r.upserted
    }
    return { periods: keys, upserted }
  }

  /** Cron diário 04:20 — re-ingere os 2 períodos mais recentes de toda org com ML. */
  @Cron('20 4 * * *', { name: 'mlBillingIngestDaily' })
  async cronDaily(): Promise<void> {
    const { data } = await supabaseAdmin.from('ml_connections').select('organization_id')
    const orgIds = [...new Set((data ?? []).map(r => (r as { organization_id: string }).organization_id))]
    this.logger.log(`[ml-billing.cron] ${orgIds.length} orgs com ML`)
    for (const orgId of orgIds) {
      try { await this.ingestRecent(orgId, 2) }
      catch (e) { this.logger.error(`[ml-billing.cron] org=${orgId.slice(0, 8)}: ${(e as Error).message}`) }
    }
  }
}
