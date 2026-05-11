#!/usr/bin/env node
/**
 * Seed inicial pra F11 E4 Visitas.
 * Replica ExecutiveVisitsService.syncRecent standalone.
 *
 * Uso: node scripts/seed-f11-visits.mjs [ORG_UUID] [DAYS=30]
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA_URL = process.env.SUPABASE_URL
const SVC_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY
const ML_CLIENT_ID     = process.env.ML_CLIENT_ID
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET

if (!SUPA_URL || !SVC_KEY || !ML_CLIENT_ID || !ML_CLIENT_SECRET) {
  console.error('[seed] env missing'); process.exit(1)
}

const admin = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } })
const targetOrg = process.argv[2] ?? null
const DAYS      = Number(process.argv[3] ?? 30)

let q = admin.from('ml_connections').select('organization_id, seller_id, access_token, refresh_token, expires_at')
if (targetOrg) q = q.eq('organization_id', targetOrg)
const { data: conns } = await q
console.log(`[seed] ${conns.length} contas a processar (últimos ${DAYS} dias)`)

async function getToken(conn) {
  if (new Date(conn.expires_at) > new Date(Date.now() + 60_000)) return conn.access_token
  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: conn.refresh_token,
    }),
  })
  if (!r.ok) throw new Error(`refresh ${r.status}`)
  const j = await r.json()
  await admin.from('ml_connections').update({
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: new Date(Date.now() + j.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('organization_id', conn.organization_id).eq('seller_id', conn.seller_id)
  return j.access_token
}

function dateOffset(date, days) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

for (const conn of conns) {
  const orgId    = conn.organization_id
  const sellerId = conn.seller_id
  console.log(`\n[seed] seller=${sellerId}`)
  let token
  try { token = await getToken(conn) } catch (e) { console.warn(`  ✗ token: ${e.message}`); continue }

  const url = `https://api.mercadolibre.com/users/${sellerId}/items_visits/time_window?last=${DAYS}&unit=day`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) { console.warn(`  ✗ /items_visits ${res.status}`); continue }
  const body = await res.json()
  const results = (body.results ?? []).sort((a, b) => a.date.localeCompare(b.date))
  console.log(`  total ${DAYS}d: ${body.total_visits} visitas em ${results.length} dias`)

  const today = new Date().toISOString().slice(0, 10)

  for (const day of results) {
    const dateKey   = day.date.slice(0, 10)
    const isPartial = dateKey === today

    // Orders do dia
    const start = `${dateKey}T00:00:00Z`
    const end   = `${dateKey}T23:59:59.999Z`
    const { data: orderRows } = await admin
      .from('orders').select('quantity')
      .eq('organization_id', orgId).eq('seller_id', sellerId)
      .eq('platform', 'mercadolivre')
      .gte('created_at', start).lte('created_at', end)
    const dayOrders = (orderRows ?? []).length
    const dayUnits  = (orderRows ?? []).reduce((acc, r) => acc + (r.quantity ?? 0), 0)
    const conv = day.total > 0 ? (dayOrders / day.total) * 100 : null

    // Comparações
    const prevDate = dateOffset(dateKey, -1)
    const lwDate   = dateOffset(dateKey, -7)
    const { data: prevRow } = await admin
      .from('ml_items_visits_daily').select('total_visits')
      .eq('organization_id', orgId).eq('seller_id', sellerId).eq('date', prevDate).maybeSingle()
    const { data: lwRow } = await admin
      .from('ml_items_visits_daily').select('total_visits')
      .eq('organization_id', orgId).eq('seller_id', sellerId).eq('date', lwDate).maybeSingle()
    const changePrev = prevRow && prevRow.total_visits > 0
      ? ((day.total - prevRow.total_visits) / prevRow.total_visits) * 100 : null
    const changeLw = lwRow && lwRow.total_visits > 0
      ? ((day.total - lwRow.total_visits) / lwRow.total_visits) * 100 : null

    const { error } = await admin.from('ml_items_visits_daily').upsert({
      organization_id: orgId, seller_id: sellerId,
      date: dateKey,
      total_visits: day.total ?? 0,
      visits_detail: day.visits_detail ?? [],
      is_partial: isPartial,
      total_orders: dayOrders, total_units_sold: dayUnits,
      conversion_rate_pct: conv,
      visits_change_pct_vs_prev_day: changePrev,
      visits_change_pct_vs_same_day_lw: changeLw,
      computed_at: new Date().toISOString(),
    }, { onConflict: 'organization_id,seller_id,date' })
    if (error) console.warn(`    ✗ ${dateKey}: ${error.message}`)
  }

  // Resumo 7d
  const since7d = dateOffset(today, -7)
  const { data: last7Data } = await admin
    .from('ml_items_visits_daily').select('total_visits, total_orders')
    .eq('organization_id', orgId).eq('seller_id', sellerId).gte('date', since7d).lt('date', today)
  const last7 = (last7Data ?? []).reduce(
    (acc, r) => ({ visits: acc.visits + r.total_visits, orders: acc.orders + r.total_orders }),
    { visits: 0, orders: 0 },
  )
  const c7 = last7.visits > 0 ? (last7.orders / last7.visits) * 100 : 0
  console.log(`  ✓ últimos 7d (excluindo hoje parcial): ${last7.visits} visitas · ${last7.orders} pedidos · conv ${c7.toFixed(3)}%`)
}

console.log('\n[seed] done')
