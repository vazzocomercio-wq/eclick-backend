import { Injectable } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { BaseAnalyzer } from './base.analyzer'
import type { AnalyzerName, SignalDraft } from './analyzers.types'

const WINDOW_DAYS = 7
const SIGNAL_TTL_HOURS = 24

const ACOS_ALTO_PCT     = 25   // ACOS > 25% = warning
const ROAS_BAIXO        = 2    // ROAS < 2 = warning
const ROAS_ALTO         = 5    // ROAS > 5 + spend significativo = oportunidade
const SPEND_MIN_INFO    = 100  // só sinaliza performance_alta se spend > 100 na janela
const SPEND_SEM_CONV    = 50   // só critical sem_conversao se spend > 50

interface CampaignRow {
  id:         string
  name:       string | null
  status:     string | null
  is_active:  boolean
  daily_budget: number | null
  type:       string | null
}

interface ReportRow {
  campaign_id:   string
  spend:         number | null
  revenue:       number | null
  conversions:   number | null
  acos:          number | null
  roas:          number | null
  clicks:        number | null
  impressions:   number | null
  date:          string
}

interface CampaignAgg {
  spend:       number
  revenue:     number
  conversions: number
  clicks:      number
  impressions: number
  reports:     number
}

/**
 * AdsAnalyzer — monitora campanhas ML Ads ativas.
 *
 * Lê ml_ads_campaigns + ml_ads_reports (últimos 7d) e agrega por campaign.
 * Categorias:
 *   sem_conversao     — spend > 50 e conversions = 0 (critical, score 85)
 *   acos_alto         — ACOS médio > 25%             (warning,  score 65)
 *   roas_baixo        — ROAS médio < 2 e spend > 50   (warning,  score 55)
 *   performance_alta  — ROAS > 5 e spend > 100        (info,     score 45)
 *
 * Calcula ACOS e ROAS agregados (não médio das linhas) usando totais
 * de spend/revenue/conversions na janela inteira.
 */
@Injectable()
export class AdsAnalyzer extends BaseAnalyzer {
  readonly name: AnalyzerName = 'ads'

  async scan(orgId: string): Promise<SignalDraft[]> {
    // 1. Campanhas ativas
    const { data: campaigns, error: cErr } = await supabaseAdmin
      .from('ml_ads_campaigns')
      .select('id, name, status, is_active, daily_budget, type')
      .eq('organization_id', orgId)
      .eq('is_active', true)
    if (cErr) {
      this.logger.error(`[ads] org=${orgId} campaigns: ${cErr.message}`)
      return []
    }
    const campaignList = (campaigns ?? []) as CampaignRow[]
    if (campaignList.length === 0) return []

    const campaignIds = campaignList.map(c => c.id)
    const campaignMap = new Map<string, CampaignRow>(campaignList.map(c => [c.id, c]))

    // 2. Reports últimos 7d
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)
    const { data: reports, error: rErr } = await supabaseAdmin
      .from('ml_ads_reports')
      .select('campaign_id, spend, revenue, conversions, acos, roas, clicks, impressions, date')
      .in('campaign_id', campaignIds)
      .gte('date', since)
    if (rErr) {
      this.logger.error(`[ads] org=${orgId} reports: ${rErr.message}`)
      return []
    }

    // 3. Agrega por campaign
    const agg = new Map<string, CampaignAgg>()
    for (const r of (reports ?? []) as ReportRow[]) {
      const cur = agg.get(r.campaign_id) ?? {
        spend: 0, revenue: 0, conversions: 0, clicks: 0, impressions: 0, reports: 0,
      }
      cur.spend       += Number(r.spend ?? 0)
      cur.revenue     += Number(r.revenue ?? 0)
      cur.conversions += Number(r.conversions ?? 0)
      cur.clicks      += Number(r.clicks ?? 0)
      cur.impressions += Number(r.impressions ?? 0)
      cur.reports     += 1
      agg.set(r.campaign_id, cur)
    }

    const drafts: SignalDraft[] = []
    const expiresAt = new Date(Date.now() + SIGNAL_TTL_HOURS * 3_600_000).toISOString()

    for (const [campaignId, totals] of agg) {
      const camp = campaignMap.get(campaignId)
      if (!camp) continue
      const draft = this.classify(campaignId, camp, totals, expiresAt)
      if (draft) drafts.push(draft)
    }

    this.logger.log(`[ads] org=${orgId} campaigns=${campaignList.length} reports=${reports?.length ?? 0} signals=${drafts.length}`)
    return drafts
  }

  private classify(
    campaignId: string, camp: CampaignRow, t: CampaignAgg, expiresAt: string,
  ): SignalDraft | null {
    const name = camp.name ?? `Campanha ${campaignId.slice(0, 8)}`
    const acos = t.revenue > 0 ? (t.spend / t.revenue) * 100 : null
    const roas = t.spend > 0 ? t.revenue / t.spend : null

    // 1. Sem conversão: spend significativo mas zero vendas
    if (t.spend > SPEND_SEM_CONV && t.conversions === 0) {
      return {
        analyzer:    this.name,
        category:    'sem_conversao',
        severity:    'critical',
        score:       85,
        entity_type: 'campaign',
        entity_id:   campaignId,
        entity_name: name,
        data: {
          spend: round(t.spend, 2), revenue: round(t.revenue, 2), conversions: 0,
          clicks: t.clicks, impressions: t.impressions, window_days: WINDOW_DAYS,
        },
        summary_pt:
          `${name}: gastou R$ ${t.spend.toFixed(2)} em ${WINDOW_DAYS}d sem nenhuma conversão ` +
          `(${t.clicks} cliques, ${t.impressions} impressões).`,
        suggestion_pt: 'Pausar campanha pra revisar segmentação, criativo ou oferta.',
        expires_at: expiresAt,
      }
    }

    // 2. ACOS alto
    if (acos != null && acos > ACOS_ALTO_PCT) {
      return {
        analyzer:    this.name,
        category:    'acos_alto',
        severity:    'warning',
        score:       Math.min(85, 55 + Math.round((acos - ACOS_ALTO_PCT) / 2)),
        entity_type: 'campaign',
        entity_id:   campaignId,
        entity_name: name,
        data: {
          acos_pct: round(acos, 1), roas: round(roas ?? 0, 2),
          spend: round(t.spend, 2), revenue: round(t.revenue, 2),
          conversions: t.conversions, window_days: WINDOW_DAYS,
        },
        summary_pt:
          `${name}: ACOS ${round(acos, 1)}% em ${WINDOW_DAYS}d ` +
          `(R$ ${t.spend.toFixed(2)} de gasto, R$ ${t.revenue.toFixed(2)} de receita).`,
        suggestion_pt: 'Revisar lances ou pausar palavras-chave de baixa conversão.',
        expires_at: expiresAt,
      }
    }

    // 3. ROAS baixo
    if (roas != null && roas < ROAS_BAIXO && t.spend > SPEND_SEM_CONV) {
      return {
        analyzer:    this.name,
        category:    'roas_baixo',
        severity:    'warning',
        score:       Math.round(50 + (ROAS_BAIXO - roas) * 10),
        entity_type: 'campaign',
        entity_id:   campaignId,
        entity_name: name,
        data: {
          roas: round(roas, 2), acos_pct: round(acos ?? 0, 1),
          spend: round(t.spend, 2), revenue: round(t.revenue, 2),
          conversions: t.conversions, window_days: WINDOW_DAYS,
        },
        summary_pt:
          `${name}: ROAS de ${round(roas, 2)}× em ${WINDOW_DAYS}d ` +
          `— retorno abaixo do mínimo recomendado.`,
        suggestion_pt: 'Avaliar segmentação, criativo ou ajustar lance pra melhorar conversão.',
        expires_at: expiresAt,
      }
    }

    // 4. Performance alta (oportunidade)
    if (roas != null && roas > ROAS_ALTO && t.spend > SPEND_MIN_INFO) {
      return {
        analyzer:    this.name,
        category:    'performance_alta',
        severity:    'info',
        score:       45,
        entity_type: 'campaign',
        entity_id:   campaignId,
        entity_name: name,
        data: {
          roas: round(roas, 2), acos_pct: round(acos ?? 0, 1),
          spend: round(t.spend, 2), revenue: round(t.revenue, 2),
          conversions: t.conversions, daily_budget: camp.daily_budget,
          window_days: WINDOW_DAYS,
        },
        summary_pt:
          `${name}: ROAS de ${round(roas, 2)}× em ${WINDOW_DAYS}d — ` +
          `oportunidade de escalar investimento.`,
        suggestion_pt: 'Considerar aumentar lance ou daily budget — campanha está rentável.',
        expires_at: expiresAt,
      }
    }

    return null
  }
}

function round(n: number, d: number): number {
  const m = Math.pow(10, d)
  return Math.round(n * m) / m
}
