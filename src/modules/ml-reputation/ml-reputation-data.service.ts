import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import type { OfficialCurrentRow } from './ml-reputation.engine'
import type { DataCoverage, WindowCounts } from './ml-reputation.types'

const ML_BASE = 'https://api.mercadolibre.com'
const BACKFILL_PAGE = 50
const BACKFILL_MAX_ORDERS = 2000

interface CountsRpcWindow {
  completed:        number
  counted:          number
  seller_cancelled: number
  claims:           number
  shipping_issues:  number
}

interface CountsRpcPayload {
  as_of:        string
  short_days:   number
  long_days:    number
  short:        CountsRpcWindow
  long:         CountsRpcWindow
  cancel_detail_coverage: { cancelled_total: number; cancelled_with_detail: number }
  oldest_sale_at: string | null
  claims_since:   string | null
  delays_since:   string | null
  window_exits:   string[]
}

export interface AccountCounts {
  short:       WindowCounts
  long:        WindowCounts
  windowExits: string[]
  coverage:    DataCoverage
}

export interface MlConnectionRow {
  seller_id: number
  nickname:  string | null
}

interface MlCancelDetail {
  group?:          string | null
  code?:           string | null
  description?:    string | null
  requested_by?:   string | null
  date?:           string | null
  application_id?: number | null
}

/**
 * Acesso a dados do módulo de reputação. Toda query filtra organization_id
 * (supabaseAdmin bypassa RLS — o isolamento entre orgs é responsabilidade
 * daqui). Conta = (organization_id, seller_id), nunca só seller_id.
 */
@Injectable()
export class MlReputationDataService {
  private readonly logger = new Logger(MlReputationDataService.name)

  constructor(private readonly ml: MercadolivreService) {}

  // ── Contas ────────────────────────────────────────────────────────────────

  async listConnections(orgId: string): Promise<MlConnectionRow[]> {
    const { data } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id, nickname')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: true })
    return ((data ?? []) as MlConnectionRow[]).map(c => ({ seller_id: Number(c.seller_id), nickname: c.nickname }))
  }

  /** Garante que a conta pertence à org — 404 (não 403) pra não revelar existência. */
  async assertAccountInOrg(orgId: string, sellerId: number): Promise<MlConnectionRow> {
    const { data } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id, nickname')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .maybeSingle()
    if (!data) throw new NotFoundException('Conta Mercado Livre não encontrada nesta organização')
    const row = data as MlConnectionRow
    return { seller_id: Number(row.seller_id), nickname: row.nickname }
  }

  async listAllConnections(): Promise<Array<{ orgId: string; sellerId: number }>> {
    const { data } = await supabaseAdmin
      .from('ml_connections')
      .select('organization_id, seller_id')
      .not('organization_id', 'is', null)
    return ((data ?? []) as Array<{ organization_id: string; seller_id: number }>)
      .map(c => ({ orgId: c.organization_id, sellerId: Number(c.seller_id) }))
  }

  // ── Contagens (1 query no banco) ──────────────────────────────────────────

  async fetchCounts(orgId: string, sellerId: number, asOf: Date, shortDays: number, longDays: number): Promise<AccountCounts> {
    const { data, error } = await supabaseAdmin.rpc('ml_reputation_account_counts', {
      p_org:        orgId,
      p_seller:     sellerId,
      p_now:        asOf.toISOString(),
      p_short_days: shortDays,
      p_long_days:  longDays,
    })
    if (error) throw new Error(`ml_reputation_account_counts: ${error.message}`)
    const p = data as CountsRpcPayload
    const toWin = (w: CountsRpcWindow | undefined): WindowCounts => ({
      completed:       Number(w?.completed ?? 0),
      counted:         Number(w?.counted ?? 0),
      sellerCancelled: Number(w?.seller_cancelled ?? 0),
      claims:          Number(w?.claims ?? 0),
      shippingIssues:  Number(w?.shipping_issues ?? 0),
    })
    return {
      short:       toWin(p?.short),
      long:        toWin(p?.long),
      windowExits: Array.isArray(p?.window_exits) ? p.window_exits : [],
      coverage: {
        oldestSaleAt:        p?.oldest_sale_at ?? null,
        claimsSince:         p?.claims_since ?? null,
        delaysSince:         p?.delays_since ?? null,
        cancelledTotal:      Number(p?.cancel_detail_coverage?.cancelled_total ?? 0),
        cancelledWithDetail: Number(p?.cancel_detail_coverage?.cancelled_with_detail ?? 0),
      },
    }
  }

  // ── Oficial (cache do sync existente) ─────────────────────────────────────

  /** Última leitura oficial (/users/{id}) + períodos do último snapshot oficial. */
  async fetchOfficialRow(orgId: string, sellerId: number): Promise<OfficialCurrentRow | null> {
    const [{ data: cur }, { data: snap }] = await Promise.all([
      supabaseAdmin
        .from('ml_seller_reputation_current')
        .select('level_id, power_seller_status, claims_rate, cancellations_rate, delayed_handling_rate, claims_count, cancellations_count, delayed_handling_count, completed_transactions, total_transactions, last_synced_at')
        .eq('organization_id', orgId)
        .eq('seller_id', sellerId)
        .maybeSingle(),
      supabaseAdmin
        .from('ml_seller_reputation_snapshots')
        .select('claims_period, cancellations_period, delayed_period')
        .eq('organization_id', orgId)
        .eq('seller_id', sellerId)
        .order('snapshot_date', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])
    if (!cur) return null
    return { ...(cur as OfficialCurrentRow), ...((snap ?? {}) as Partial<OfficialCurrentRow>) }
  }

  // ── Backfill do cancel_detail ─────────────────────────────────────────────

  /**
   * O ingestor só passou a gravar `cancel_detail` (quem cancelou) agora.
   * Pedidos cancelados antigos ficam sem essa informação e o indicador
   * "canceladas por você" sairia subestimado. Busca os cancelados da conta
   * na janela longa direto no ML e grava só o cancel_detail (RPC faz merge
   * no raw_data). Idempotente: rodar de novo só reescreve o mesmo campo.
   */
  async backfillCancelDetails(orgId: string, sellerId: number, days: number): Promise<{ fetched: number; updated: number; truncated: boolean }> {
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)
    const to   = new Date()
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
    const fmt  = (d: Date) => d.toISOString().slice(0, 10)

    let offset = 0
    let total: number | null = null
    let fetched = 0
    let updated = 0

    do {
      const url =
        `${ML_BASE}/orders/search?seller=${sellerId}&order.status=cancelled&limit=${BACKFILL_PAGE}&offset=${offset}` +
        `&order.date_created.from=${fmt(from)}T00:00:00.000-03:00&order.date_created.to=${fmt(to)}T23:59:59.999-03:00`
      const { data } = await axios.get<{ results?: Array<{ id: number; cancel_detail?: MlCancelDetail | null }>; paging?: { total?: number } }>(
        url, { headers: { Authorization: `Bearer ${token}` }, timeout: 20_000 },
      )
      const results = data?.results ?? []
      if (total === null) total = data?.paging?.total ?? 0
      fetched += results.length

      for (const o of results) {
        if (!o?.id || !o.cancel_detail) continue
        const { data: n, error } = await supabaseAdmin.rpc('ml_reputation_set_cancel_detail', {
          p_org:               orgId,
          p_seller:            sellerId,
          p_external_order_id: String(o.id),
          p_detail:            o.cancel_detail,
        })
        if (error) {
          this.logger.warn(`[backfill] order=${o.id}: ${error.message}`)
          continue
        }
        updated += Number(n ?? 0) > 0 ? 1 : 0
      }

      offset += BACKFILL_PAGE
      if (results.length === 0) break
    } while (fetched < (total ?? 0) && fetched < BACKFILL_MAX_ORDERS)

    const truncated = (total ?? 0) > fetched
    this.logger.log(`[backfill] org=${orgId.slice(0, 8)} seller=${sellerId} cancelados=${fetched}/${total ?? 0} atualizados=${updated}${truncated ? ' (TRUNCADO)' : ''}`)
    return { fetched, updated, truncated }
  }

  // ── Backfill de reclamações ──────────────────────────────────────────────

  /**
   * `ml_claims` só é alimentada pelo webhook `claims` — conta conectada antes
   * do webhook (ou com o tópico desligado no app ML) fica sem histórico e o
   * indicador local de reclamações sairia 0% com aviso "sem dado". Busca as
   * reclamações em que o seller é o reclamado (player_role=respondent) na
   * janela longa e grava com o MESMO upsert do MlClaimsService
   * (onConflict organization_id,ml_claim_id) — idempotente, sem disparar os
   * alertas de "reclamação aberta" (histórico, não evento novo).
   */
  async backfillClaims(orgId: string, sellerId: number, days: number): Promise<{ fetched: number; upserted: number; truncated: boolean }> {
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)
    const since = Date.now() - days * 24 * 60 * 60 * 1000
    const PAGE = 30
    let offset = 0
    let total: number | null = null
    let fetched = 0
    let upserted = 0
    let reachedWindowEnd = false

    interface MlClaimSearchItem {
      id: number
      type?: string | null
      stage?: string | null
      status?: string | null
      reason_id?: string | null
      reason?: { name?: string | null } | null
      resource_id?: number | null
      date_created: string
      last_updated?: string | null
      players?: Array<{ role?: string; user_id?: number }>
    }

    do {
      const url =
        `${ML_BASE}/post-purchase/v1/claims/search?player_role=respondent&limit=${PAGE}&offset=${offset}&sort=date_created:desc`
      const { data } = await axios.get<{ paging?: { total?: number }; data?: MlClaimSearchItem[]; results?: MlClaimSearchItem[] }>(
        url, { headers: { Authorization: `Bearer ${token}` }, timeout: 20_000 },
      )
      const results = data?.data ?? data?.results ?? []
      if (total === null) total = data?.paging?.total ?? results.length
      fetched += results.length

      for (const c of results) {
        if (!c?.id || !c.date_created) continue
        if (new Date(c.date_created).getTime() < since) { reachedWindowEnd = true; continue }
        // Conta certa: em org multi-conta o token já é da conta, mas o ML pode
        // devolver claims de outros papéis — filtra pelo respondent quando vier.
        const respondent = c.players?.find(p => p.role === 'respondent')
        if (respondent?.user_id && Number(respondent.user_id) !== sellerId) continue

        const { error } = await supabaseAdmin.from('ml_claims').upsert({
          organization_id: orgId,
          ml_claim_id:     c.id,
          ml_resource_id:  c.resource_id ?? null,
          type:            c.type ?? null,
          stage:           c.stage ?? null,
          status:          c.status ?? null,
          reason_id:       c.reason_id ?? null,
          reason_name:     c.reason?.name ?? null,
          date_created:    c.date_created,
          last_updated:    c.last_updated ?? null,
          raw:             c as unknown,
        }, { onConflict: 'organization_id,ml_claim_id' })
        if (error) { this.logger.warn(`[backfill-claims] claim=${c.id}: ${error.message}`); continue }
        upserted++
      }

      offset += PAGE
      if (results.length === 0) break
    } while (!reachedWindowEnd && fetched < (total ?? 0) && fetched < BACKFILL_MAX_ORDERS)

    const truncated = !reachedWindowEnd && (total ?? 0) > fetched
    this.logger.log(`[backfill-claims] org=${orgId.slice(0, 8)} seller=${sellerId} lidas=${fetched}/${total ?? 0} gravadas=${upserted}${truncated ? ' (TRUNCADO)' : ''}`)
    return { fetched, upserted, truncated }
  }
}
