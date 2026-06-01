import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { CampaignCard, CampaignMetrics, CampaignKind } from './shopee-campaigns.types'
import { SyncedCampaignRow } from '../adapters/shopee.adapter'

/** F18 F1.4 — Campaign Center service.
 *
 *  READ-ONLY na Sprint 1. CRUD completo (criar/editar/sincronizar com
 *  Shopee /api/v2/voucher|discount|ads) entra na Sprint 2 quando creds
 *  Open Platform aprovarem.
 *
 *  ROI calculado em DB (computed via service por enquanto). Margin gate
 *  é placeholder — F1.6 plugará no motor de margem central (margin.ts).
 */
@Injectable()
export class ShopeeCampaignsService {
  private readonly logger = new Logger(ShopeeCampaignsService.name)

  /** Lista campanhas da org, opcional filter por kind/status. Sort:
   *  ativas primeiro, depois por starts_at desc. */
  async list(args: {
    orgId:   string
    kind?:   CampaignKind | null
    status?: string | null
    limit?:  number
    offset?: number
  }): Promise<{ items: CampaignCard[]; total: number }> {
    let q = supabaseAdmin
      .schema('shopee')
      .from('v_campaigns_with_shop')
      .select('*', { count: 'exact' })
      .eq('organization_id', args.orgId)
      .order('status_priority', { ascending: true })
      .order('starts_at',       { ascending: false })
      .range(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 50) - 1)

    if (args.kind)   q = q.eq('kind',   args.kind)
    if (args.status) q = q.eq('status', args.status)

    const { data, count, error } = await q
    if (error) {
      this.logger.error(`[shopee.campaigns] list falhou: ${error.message}`)
      throw new Error(error.message)
    }

    const rows = (data ?? []) as unknown as Row[]
    return {
      items: rows.map(r => this.toCard(r)),
      total: count ?? rows.length,
    }
  }

  /** Lê uma campanha específica. */
  async getById(orgId: string, campaignId: string): Promise<CampaignCard | null> {
    const { data, error } = await supabaseAdmin
      .schema('shopee')
      .from('v_campaigns_with_shop')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', campaignId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return null
    return this.toCard(data as unknown as Row)
  }

  /** F1.4 sync — substitui as campanhas SINCRONIZADAS (external_id NOT NULL) da
   *  loja pelas atuais. Delete+insert preserva linhas demo/manual (external_id
   *  null) e evita precisar de constraint única (sem migration). revenue/cost/
   *  orders = 0 (voucher/flash_sale não têm spend/GMV — só o módulo Ads). */
  async replaceSyncedCampaigns(orgId: string, shopId: number, rows: SyncedCampaignRow[]): Promise<number> {
    const del = await supabaseAdmin
      .schema('shopee')
      .from('campaigns')
      .delete()
      .eq('organization_id', orgId)
      .eq('shop_id', shopId)
      .not('external_id', 'is', null)
    if (del.error) {
      this.logger.error(`[shopee.campaigns] delete sincronizadas: ${del.error.message}`)
      throw new Error(del.error.message)
    }
    if (!rows.length) return 0

    const payload = rows.map(r => ({
      organization_id: orgId,
      shop_id:         shopId,
      kind:            r.kind,
      status:          r.status,
      title:           r.title,
      config:          r.config,
      starts_at:       r.starts_at,
      ends_at:         r.ends_at,
      revenue_cents:   0,
      cost_cents:      0,
      orders:          0,
      external_id:     r.external_id,
      raw:             r.raw ?? null,
    }))
    const ins = await supabaseAdmin
      .schema('shopee')
      .from('campaigns')
      .insert(payload)
    if (ins.error) {
      this.logger.error(`[shopee.campaigns] insert sincronizadas: ${ins.error.message}`)
      throw new Error(ins.error.message)
    }
    return rows.length
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Computa ROI. cost == 0 → null (não dividir por zero; UI mostra "—"). */
  private computeROI(m: CampaignMetrics): number | null {
    if (!m.cost_cents || m.cost_cents <= 0) return null
    return (m.revenue_cents - m.cost_cents) / m.cost_cents
  }

  private toCard(r: Row): CampaignCard {
    const metrics: CampaignMetrics = {
      revenue_cents:  Number(r.revenue_cents  ?? 0),
      cost_cents:     Number(r.cost_cents     ?? 0),
      orders:         Number(r.orders         ?? 0),
      views:          r.views   != null ? Number(r.views)   : undefined,
      clicks:         r.clicks  != null ? Number(r.clicks)  : undefined,
    }
    return {
      id:                r.id,
      organization_id:   r.organization_id,
      shop_id:           Number(r.shop_id),
      shop_name:         r.shop_name ?? null,
      kind:              r.kind as CampaignKind,
      status:            r.status as CampaignCard['status'],
      title:             r.title,
      config:            (r.config ?? {}) as Record<string, unknown>,
      starts_at:         r.starts_at,
      ends_at:           r.ends_at,
      metrics,
      roi:               this.computeROI(metrics),
      margin_warning:    r.margin_warning ?? null,
      created_at:        r.created_at,
      updated_at:        r.updated_at,
    }
  }
}

interface Row {
  id:                string
  organization_id:   string
  shop_id:           number
  kind:              string
  status:            string
  title:             string
  config:            unknown
  starts_at:         string
  ends_at:           string | null
  revenue_cents:     number | null
  cost_cents:        number | null
  orders:            number | null
  views:             number | null
  clicks:            number | null
  margin_warning:    string | null
  created_at:        string
  updated_at:        string
  shop_name:         string | null
  status_priority:   number
}
