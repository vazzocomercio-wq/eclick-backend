import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { AlgoScoreIssue } from './algo-score.types'

export interface ListingScoreFilters {
  orgId:     string
  limit:     number
  offset:    number
  minScore:  number | null
  maxScore:  number | null
  shopId:    number | null
}

/** Shape devolvido pra UI. title/main_image_url são extraídos do
 *  input_snapshot quando product_id é null (modo demo) — quando F0.7
 *  popular products real, vem do JOIN. */
export interface ListingScoreCard {
  shop_id:         number
  item_id:         number
  product_id:      string | null
  title:           string | null
  main_image_url:  string | null
  score:           number
  pillars:         {
    relevance:        number
    performance:      number
    seller_quality:   number
    price_marketing:  number
  }
  top_issues:      AlgoScoreIssue[]
  total_issues:    number
  computed_at:     string
  /** datas do ANÚNCIO na Shopee (do input_snapshot) — só pra ordenar a lista.
   *  updated_at preenche após o próximo sync de produtos. */
  created_at:      string | null
  updated_at:      string | null
}

/** F18 F1.2 — Lê scores recentes da view shopee.v_latest_algo_score. */
@Injectable()
export class ShopeeListingsService {
  private readonly logger = new Logger(ShopeeListingsService.name)

  async listLatestScores(f: ListingScoreFilters): Promise<{ items: ListingScoreCard[]; total: number }> {
    let q = supabaseAdmin
      .schema('shopee')
      .from('v_latest_algo_score')
      .select(
        'shop_id, item_id, product_id, algo_score, relevance, performance, ' +
        'seller_quality, price_marketing, issues, input_snapshot, computed_at',
        { count: 'exact' },
      )
      .eq('organization_id', f.orgId)
      .order('algo_score', { ascending: true })  // piores primeiro — priorizar correção
      .order('computed_at', { ascending: false })
      .range(f.offset, f.offset + f.limit - 1)

    if (f.shopId   != null) q = q.eq('shop_id', f.shopId)
    if (f.minScore != null) q = q.gte('algo_score', f.minScore)
    if (f.maxScore != null) q = q.lte('algo_score', f.maxScore)

    const { data, count, error } = await q
    if (error) {
      this.logger.error(`[shopee.listings] query falhou: ${error.message}`)
      throw new Error(error.message)
    }

    const rows = (data ?? []) as unknown as Row[]
    const items = rows.map(r => this.toCard(r))
    return { items, total: count ?? items.length }
  }

  private toCard(r: Row): ListingScoreCard {
    const snap = (r.input_snapshot ?? {}) as Record<string, unknown>
    const issues = Array.isArray(r.issues) ? (r.issues as AlgoScoreIssue[]) : []
    return {
      shop_id:         Number(r.shop_id),
      item_id:         Number(r.item_id),
      product_id:      r.product_id,
      title:           (snap.title as string | undefined) ?? null,
      main_image_url:  (snap.main_image_url as string | undefined) ?? null,
      score:           r.algo_score,
      pillars: {
        relevance:        r.relevance,
        performance:      r.performance,
        seller_quality:   r.seller_quality,
        price_marketing:  r.price_marketing,
      },
      top_issues:      issues.slice(0, 3),
      total_issues:    issues.length,
      computed_at:     r.computed_at,
      created_at:      (snap.created_at as string | undefined) ?? null,
      updated_at:      (snap.updated_at as string | undefined) ?? null,
    }
  }
}

interface Row {
  shop_id:         number
  item_id:         number
  product_id:      string | null
  algo_score:      number
  relevance:       number
  performance:     number
  seller_quality:  number
  price_marketing: number
  issues:          unknown
  input_snapshot:  unknown
  computed_at:     string
}
