import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'

/** F18 F4.5 — Métricas da Ponte (north-star).
 *
 *  A tese de "best/smartest Shopee integration no BR": medir o GMV gerado
 *  via afiliados DA PLATAFORMA + saúde do matchmaking.
 *
 *  Fontes:
 *  - shopee.match_offers      → matches (active/accepted/open), match score
 *  - shopee.affiliate_conversions → GMV + comissão (pending/confirmed)
 *
 *  ⚠️ Atribuição precisa conversão↔match (via sub_id) ainda não está
 *  linkada — GMV aqui é o total de afiliados; o link fino vem quando o
 *  ingestion real (F2.2) popular sub_id nas conversões. */
@Injectable()
export class PonteMetricsService {
  private readonly logger = new Logger(PonteMetricsService.name)

  async summary(orgId: string): Promise<PonteMetrics> {
    // Matches
    const { data: matches, error: mErr } = await supabaseAdmin
      .schema('shopee')
      .from('match_offers')
      .select('status, match_score, affiliate_profile_id, proposed_commission_pct')
      .eq('organization_id', orgId)
    if (mErr) { this.logger.error(`[ponte] matches: ${mErr.message}`); throw new Error(mErr.message) }

    const m = (matches ?? []) as MatchRow[]
    const activeStatuses = new Set(['accepted', 'active'])
    const active   = m.filter(r => activeStatuses.has(r.status))
    const open     = m.filter(r => r.status === 'open')
    const accepted = m.filter(r => r.status === 'accepted' || r.status === 'active')

    const activeAffiliates = new Set(active.map(r => r.affiliate_profile_id)).size
    const avgMatchScore = accepted.length > 0
      ? Math.round(accepted.reduce((s, r) => s + Number(r.match_score ?? 0), 0) / accepted.length)
      : null
    const acceptanceRate = m.length > 0
      ? (accepted.length / m.length)
      : null

    // Conversões (GMV + comissão)
    const { data: convs, error: cErr } = await supabaseAdmin
      .schema('shopee')
      .from('affiliate_conversions')
      .select('state, order_value_cents, commission_cents')
      .eq('organization_id', orgId)
    if (cErr) { this.logger.error(`[ponte] convs: ${cErr.message}`); throw new Error(cErr.message) }

    let gmvConfirmed = 0, gmvPending = 0, commConfirmed = 0, commPending = 0
    let nConfirmed = 0, nPending = 0
    for (const c of (convs ?? []) as ConvRow[]) {
      const gmv  = Number(c.order_value_cents ?? 0)
      const comm = Number(c.commission_cents ?? 0)
      if (c.state === 'confirmed') { gmvConfirmed += gmv; commConfirmed += comm; nConfirmed++ }
      else if (c.state === 'pending') { gmvPending += gmv; commPending += comm; nPending++ }
    }

    return {
      matches: {
        total:            m.length,
        active:           active.length,
        open:             open.length,
        active_affiliates: activeAffiliates,
        avg_match_score:  avgMatchScore,
        acceptance_rate:  acceptanceRate,
      },
      gmv: {
        confirmed_cents:  gmvConfirmed,
        pending_cents:    gmvPending,
        total_cents:      gmvConfirmed + gmvPending,
      },
      commission: {
        confirmed_cents:  commConfirmed,
        pending_cents:    commPending,
      },
      conversions: {
        confirmed: nConfirmed,
        pending:   nPending,
      },
    }
  }
}

interface MatchRow {
  status:                  string
  match_score:             number
  affiliate_profile_id:    string
  proposed_commission_pct: number
}
interface ConvRow {
  state:             string
  order_value_cents: number | null
  commission_cents:  number | null
}

export interface PonteMetrics {
  matches: {
    total:             number
    active:            number
    open:              number
    active_affiliates: number
    avg_match_score:   number | null
    acceptance_rate:   number | null
  }
  gmv: {
    confirmed_cents: number
    pending_cents:   number
    total_cents:     number
  }
  commission: {
    confirmed_cents: number
    pending_cents:   number
  }
  conversions: {
    confirmed: number
    pending:   number
  }
}
