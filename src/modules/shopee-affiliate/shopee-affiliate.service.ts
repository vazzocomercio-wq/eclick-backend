import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { OpportunityScoreService } from './opportunity-score.service'
import { OpportunityBreakdown } from './opportunity-score.types'

/** F18 F2.1+F2.3 — Service do lado Afiliado.
 *
 *  READ + score na Sprint 1. Ingestion das ofertas (Affiliate API
 *  affiliate.shopee.com.br) vem na Sprint 2 quando App ID/Secret aprovarem.
 *
 *  Discovery: lista ofertas ranqueadas por opportunity_score desc, com
 *  excluídas (rating<4.5 / seller fraco) no fim. */
@Injectable()
export class ShopeeAffiliateService {
  private readonly logger = new Logger(ShopeeAffiliateService.name)

  constructor(private readonly opportunity: OpportunityScoreService) {}

  /** Status da conexão Affiliate da org (existe app_id configurado?). */
  async connectionStatus(orgId: string): Promise<{ connected: boolean; affiliate_id: string | null; status: string | null }> {
    const { data } = await supabaseAdmin
      .schema('shopee')
      .from('affiliate_connections')
      .select('affiliate_id, status')
      .eq('organization_id', orgId)
      .maybeSingle()
    const row = data as { affiliate_id: string | null; status: string | null } | null
    return {
      connected:    !!row && row.status === 'active',
      affiliate_id: row?.affiliate_id ?? null,
      status:       row?.status ?? null,
    }
  }

  /** Lista ofertas com Opportunity Score recalculado on-the-fly + ordenado.
   *  Filtros opcionais: categoria, comissão mínima, incluir excluídas. */
  async discoverOffers(args: {
    orgId:          string
    category?:      string | null
    minCommission?: number | null      // 0-1
    includeExcluded?: boolean
    limit?:         number
    offset?:        number
  }): Promise<{ items: OfferCard[]; total: number }> {
    let q = supabaseAdmin
      .schema('shopee')
      .from('affiliate_offers')
      .select('*', { count: 'exact' })
      .eq('organization_id', args.orgId)
      .order('opportunity_score', { ascending: false })
      .order('fetched_at',        { ascending: false })
      .range(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 50) - 1)

    if (args.category)            q = q.eq('category', args.category)
    if (args.minCommission != null) q = q.gte('commission_rate', args.minCommission)

    const { data, count, error } = await q
    if (error) {
      this.logger.error(`[shopee.affiliate] discover falhou: ${error.message}`)
      throw new Error(error.message)
    }

    const rows = (data ?? []) as unknown as OfferRow[]
    const items = rows
      .map(r => this.toCard(r))
      .filter(c => args.includeExcluded ? true : !c.opportunity.excluded)

    return { items, total: count ?? items.length }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private toCard(r: OfferRow): OfferCard {
    // Recalcula o breakdown on-the-fly pra UI ter components + exclude_reason
    // (DB guarda só o score final). Garante consistência com o motor.
    const breakdown = this.opportunity.compute({
      item_id:         Number(r.item_id),
      shop_id:         r.shop_id != null ? Number(r.shop_id) : null,
      name:            r.name,
      category:        r.category,
      price_cents:     r.price_cents != null ? Number(r.price_cents) : null,
      commission_rate: Number(r.commission_rate),
      rating:          r.rating != null ? Number(r.rating) : null,
      sales_volume:    r.sales_volume != null ? Number(r.sales_volume) : null,
      seller_score:    r.seller_score != null ? Number(r.seller_score) : null,
      trend_score:     r.trend_score != null ? Number(r.trend_score) : null,
    })
    return {
      item_id:         Number(r.item_id),
      shop_id:         r.shop_id != null ? Number(r.shop_id) : null,
      name:            r.name,
      category:        r.category,
      price_cents:     r.price_cents != null ? Number(r.price_cents) : null,
      commission_rate: Number(r.commission_rate),
      rating:          r.rating != null ? Number(r.rating) : null,
      sales_volume:    r.sales_volume != null ? Number(r.sales_volume) : null,
      seller_score:    r.seller_score != null ? Number(r.seller_score) : null,
      opportunity:     breakdown,
      fetched_at:      r.fetched_at,
    }
  }
}

export interface OfferCard {
  item_id:          number
  shop_id:          number | null
  name:             string | null
  category:         string | null
  price_cents:      number | null
  commission_rate:  number
  rating:           number | null
  sales_volume:     number | null
  seller_score:     number | null
  opportunity:      OpportunityBreakdown
  fetched_at:       string
}

interface OfferRow {
  item_id:          number
  shop_id:          number | null
  name:             string | null
  category:         string | null
  price_cents:      number | null
  commission_rate:  number
  rating:           number | null
  sales_volume:     number | null
  seller_score:     number | null
  trend_score:      number | null
  opportunity_score: number
  fetched_at:       string
}
