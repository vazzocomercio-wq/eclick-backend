import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { MatchScoreService } from './match-score.service'
import { MatchBreakdown, MatchStatus } from './match-score.types'

/** F18 F4.1 — Matchmaker service. Liga vendedor (produto) ↔ afiliados do
 *  diretório, ranqueando por Match Score. Vendedor propõe comissão →
 *  afiliado aceita → vira match ativo (medido em conversions).
 *
 *  Diretório de afiliados é opt-in (Consent gate F4.3). Bridge pro Active
 *  CRM (F4.4) e métricas north-star (F4.5) vêm em seguida. */
@Injectable()
export class MatchmakerService {
  private readonly logger = new Logger(MatchmakerService.name)

  constructor(private readonly matchScore: MatchScoreService) {}

  /** Pro VENDEDOR: afiliados ranqueados por fit com um produto.
   *  Recebe a categoria/nicho do produto; cruza com o diretório opt-in. */
  async rankAffiliatesForProduct(args: {
    orgId:    string
    category: string | null
    niche:    string | null
    limit?:   number
  }): Promise<RankedAffiliate[]> {
    const { data, error } = await supabaseAdmin
      .schema('shopee')
      .from('affiliate_profiles')
      .select('id, display_name, niches, channels, reach_estimate, avg_conversion_rate, niche_conversion, status')
      .eq('status', 'active')           // só afiliados com consent ativo
      .limit(args.limit ?? 50)
    if (error) {
      this.logger.error(`[matchmaker] rank: ${error.message}`)
      throw new Error(error.message)
    }

    const product = { category: args.category, niche: args.niche }
    const ranked = ((data ?? []) as unknown as ProfileRow[]).map(p => {
      const breakdown: MatchBreakdown = this.matchScore.compute(product, {
        niches:               p.niches ?? [],
        channels:             p.channels ?? [],
        reach_estimate:       Number(p.reach_estimate ?? 0),
        avg_conversion_rate:  p.avg_conversion_rate != null ? Number(p.avg_conversion_rate) : null,
        niche_conversion:     (p.niche_conversion ?? null) as Record<string, number> | null,
      })
      return {
        affiliate_id:    p.id,
        display_name:    p.display_name,
        niches:          p.niches ?? [],
        channels:        p.channels ?? [],
        reach_estimate:  Number(p.reach_estimate ?? 0),
        match:           breakdown,
      }
    })
    return ranked.sort((a, b) => b.match.score - a.match.score)
  }

  /** Vendedor cria proposta de match pra um afiliado. */
  async createOffer(args: {
    orgId:                   string
    sellerShopId:            number
    itemId:                  number
    affiliateProfileId:      string
    proposedCommissionPct:   number   // 0-1
    category?:               string | null
    niche?:                  string | null
  }): Promise<{ id: string; match_score: number }> {
    // Recomputa match_score no momento da proposta (snapshot)
    const { data: prof } = await supabaseAdmin
      .schema('shopee')
      .from('affiliate_profiles')
      .select('niches, channels, reach_estimate, avg_conversion_rate, niche_conversion')
      .eq('id', args.affiliateProfileId)
      .maybeSingle()
    if (!prof) throw new BadRequestException('Afiliado não encontrado no diretório')
    const p = prof as ProfileRow

    const breakdown = this.matchScore.compute(
      { category: args.category ?? null, niche: args.niche ?? null },
      {
        niches:              p.niches ?? [],
        channels:            p.channels ?? [],
        reach_estimate:      Number(p.reach_estimate ?? 0),
        avg_conversion_rate: p.avg_conversion_rate != null ? Number(p.avg_conversion_rate) : null,
        niche_conversion:    (p.niche_conversion ?? null) as Record<string, number> | null,
      },
    )

    const { data, error } = await supabaseAdmin
      .schema('shopee')
      .from('match_offers')
      .insert({
        organization_id:         args.orgId,
        seller_shop_id:          args.sellerShopId,
        item_id:                 args.itemId,
        affiliate_profile_id:    args.affiliateProfileId,
        proposed_commission_pct: args.proposedCommissionPct,
        match_score:             breakdown.score,
        match_breakdown:         breakdown,
        status:                  'open',
      })
      .select('id, match_score')
      .single()
    if (error) {
      this.logger.error(`[matchmaker] createOffer: ${error.message}`)
      throw new Error(error.message)
    }
    return data as { id: string; match_score: number }
  }

  /** Lista propostas de match da org (vendedor) ou direcionadas a um
   *  afiliado (status filter opcional). */
  async listOffers(orgId: string, status?: MatchStatus): Promise<OfferRow[]> {
    let q = supabaseAdmin
      .schema('shopee')
      .from('v_match_offers')
      .select('*')
      .eq('organization_id', orgId)
      .order('match_score', { ascending: false })
      .order('created_at',  { ascending: false })
      .limit(200)
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return (data ?? []) as unknown as OfferRow[]
  }

  /** Afiliado aceita/recusa uma proposta. */
  async respondOffer(orgId: string, offerId: string, action: 'accept' | 'decline'): Promise<void> {
    const status: MatchStatus = action === 'accept' ? 'accepted' : 'declined'
    const { error } = await supabaseAdmin
      .schema('shopee')
      .from('match_offers')
      .update({ status, responded_at: new Date().toISOString() })
      .eq('id', offerId)
      .eq('organization_id', orgId)
    if (error) throw new Error(error.message)
  }
}

interface ProfileRow {
  id:                   string
  display_name:         string | null
  niches:               string[] | null
  channels:             string[] | null
  reach_estimate:       number | null
  avg_conversion_rate:  number | null
  niche_conversion:     unknown
  status?:              string
}

export interface RankedAffiliate {
  affiliate_id:    string
  display_name:    string | null
  niches:          string[]
  channels:        string[]
  reach_estimate:  number
  match:           MatchBreakdown
}

export interface OfferRow {
  id:                      string
  organization_id:         string
  seller_shop_id:          number
  item_id:                 number
  affiliate_profile_id:    string
  affiliate_name:          string | null
  proposed_commission_pct: number
  match_score:             number
  match_breakdown:         unknown
  status:                  string
  created_at:              string
  responded_at:            string | null
}
