#!/usr/bin/env node
/**
 * Seed inicial pra F11 E5 Ads Visibility.
 * Replica ExecutiveAdsService.refreshSummary standalone — só Postgres,
 * sem chamadas ML. Calcula spend/revenue/acos/roas 7d + 14d + counts e
 * grava em ml_ads_summary.
 *
 * Uso: node scripts/seed-f11-ads.mjs [ORG_UUID]
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } },
)

const targetOrg = process.argv[2] ?? null
const DEFAULT_THRESHOLD = 0.30

function dateOffset(date, days) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

async function sumWindow(orgId, from, toEx) {
  const { data } = await admin.from('ml_ads_reports')
    .select('spend, revenue, clicks, impressions, conversions')
    .eq('organization_id', orgId).gte('date', from).lt('date', toEx)
  return (data ?? []).reduce((acc, r) => ({
    spend:       acc.spend       + Number(r.spend       ?? 0),
    revenue:     acc.revenue     + Number(r.revenue     ?? 0),
    clicks:      acc.clicks      + Number(r.clicks      ?? 0),
    impressions: acc.impressions + Number(r.impressions ?? 0),
    conversions: acc.conversions + Number(r.conversions ?? 0),
  }), { spend: 0, revenue: 0, clicks: 0, impressions: 0, conversions: 0 })
}

async function refreshOrg(orgId) {
  const today    = new Date().toISOString().slice(0, 10)
  const since7d  = dateOffset(today,  -7)
  const since14d = dateOffset(today, -14)

  // Campanhas + advertisers
  const { data: camps = [] } = await admin.from('ml_ads_campaigns')
    .select('id, advertiser_id, status').eq('organization_id', orgId)
  const advertisers = Array.from(new Set(camps.map(c => c.advertiser_id))).filter(Boolean)
  const active = camps.filter(c => c.status === 'active' || c.status === 'ACTIVE').length
  const paused = camps.filter(c => c.status === 'paused' || c.status === 'PAUSED').length

  // Reports 7d/14d
  const [last7, prev7] = await Promise.all([
    sumWindow(orgId, since7d,  today),
    sumWindow(orgId, since14d, since7d),
  ])

  const acos7d = last7.spend > 0 && last7.revenue > 0 ? last7.spend / last7.revenue : null
  const roas7d = last7.spend > 0 ? last7.revenue / last7.spend : null
  const ctr7d  = last7.impressions > 0 ? (last7.clicks / last7.impressions) * 100 : null

  // Por campanha (losing money / winning)
  const { data: byCamp = [] } = await admin.from('ml_ads_reports')
    .select('campaign_id, spend, revenue')
    .eq('organization_id', orgId).gte('date', since7d).lt('date', today)
  const per = new Map()
  for (const r of byCamp) {
    const p = per.get(r.campaign_id) ?? { spend: 0, revenue: 0 }
    p.spend   += Number(r.spend   ?? 0)
    p.revenue += Number(r.revenue ?? 0)
    per.set(r.campaign_id, p)
  }
  let losing = 0, winning = 0
  for (const s of per.values()) {
    if (s.spend <= 0) continue
    const a = s.revenue > 0 ? s.spend / s.revenue : Infinity
    const r = s.revenue / s.spend
    if (a > DEFAULT_THRESHOLD) losing++
    if (r > 3) winning++
  }

  const spendChange   = prev7.spend > 0   ? ((last7.spend   - prev7.spend)   / prev7.spend)   * 100 : null
  const revenueChange = prev7.revenue > 0 ? ((last7.revenue - prev7.revenue) / prev7.revenue) * 100 : null

  await admin.from('ml_ads_summary').upsert({
    organization_id: orgId,
    ads_spend_7d:    last7.spend,
    ads_revenue_7d:  last7.revenue,
    ads_clicks_7d:   last7.clicks,
    ads_impressions_7d: last7.impressions,
    ads_conversions_7d: last7.conversions,
    ads_acos_7d:     acos7d,
    ads_roas_7d:     roas7d,
    ads_ctr_7d:      ctr7d,
    ads_spend_change_pct:   spendChange,
    ads_revenue_change_pct: revenueChange,
    ads_campaigns_active:   active,
    ads_campaigns_paused:   paused,
    ads_campaigns_losing_money: losing,
    ads_campaigns_winning:      winning,
    has_advertiser:    camps.length > 0,
    advertiser_ids:    advertisers,
    acos_threshold:    DEFAULT_THRESHOLD,
    last_refresh_at:   new Date().toISOString(),
    next_sync_at:      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }, { onConflict: 'organization_id' })

  return { last7, acos7d, roas7d, ctr7d, active, paused, losing, winning, advertisers }
}

let q = admin.from('ml_ads_campaigns').select('organization_id')
if (targetOrg) q = q.eq('organization_id', targetOrg)
const { data: rows = [] } = await q
const orgs = Array.from(new Set(rows.map(r => r.organization_id).filter(Boolean)))
console.log(`[seed] ${orgs.length} orgs com ads`)

for (const orgId of orgs) {
  console.log(`\n[seed] org=${orgId.slice(0,8)}`)
  try {
    const r = await refreshOrg(orgId)
    const brl = v => (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    const pct = v => v == null ? '—' : `${(v * 100).toFixed(1)}%`
    console.log(`  spend=${brl(r.last7.spend)} revenue=${brl(r.last7.revenue)}`)
    console.log(`  acos=${pct(r.acos7d)} roas=${r.roas7d?.toFixed(2) ?? '—'}x ctr=${r.ctr7d?.toFixed(2) ?? '—'}%`)
    console.log(`  campanhas: ${r.active} ativas · ${r.paused} pausadas · ${r.losing} perdendo · ${r.winning} vencendo`)
    console.log(`  advertisers: ${r.advertisers.join(', ')}`)
  } catch (e) {
    console.warn(`  ✗ ${e.message}`)
  }
}

console.log('\n[seed] done')
