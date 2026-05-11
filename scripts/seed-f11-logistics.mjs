#!/usr/bin/env node
/**
 * Seed inicial pra F11 E3 Logística.
 * Replica scanDelays + scanFlex + refreshSummary do ExecutiveLogisticsService
 * standalone (sem precisar subir servidor).
 *
 * Uso: node scripts/seed-f11-logistics.mjs [ORG_UUID]
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
const DELAY_SCAN_DAYS = 30
const FLEX_BATCH      = 200
const FLEX_PAUSE_MS   = 60

let q = admin.from('ml_connections').select('organization_id, seller_id, access_token, refresh_token, expires_at')
if (targetOrg) q = q.eq('organization_id', targetOrg)
const { data: conns } = await q
console.log(`[seed] ${conns.length} contas a processar`)

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

for (const conn of conns) {
  const orgId = conn.organization_id
  const sellerId = conn.seller_id
  console.log(`\n[seed] seller=${sellerId}`)
  let token
  try { token = await getToken(conn) } catch (e) { console.warn(`  ✗ token: ${e.message}`); continue }

  // ── 1. scanDelays
  const since = new Date(Date.now() - DELAY_SCAN_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { data: orders } = await admin.from('orders')
    .select('shipping_id, external_order_id')
    .eq('organization_id', orgId).eq('seller_id', sellerId)
    .eq('platform', 'mercadolivre').not('shipping_id', 'is', null)
    .gte('created_at', since).limit(2000)

  const seen = new Map()
  for (const o of (orders ?? [])) {
    if (o.shipping_id && !seen.has(o.shipping_id)) seen.set(o.shipping_id, o.external_order_id)
  }

  let delaysFound = 0, autoResolved = 0
  let n = 0
  for (const [shipId, orderId] of seen) {
    n++
    if (n % 100 === 0) console.log(`    delays progresso ${n}/${seen.size}`)
    try {
      const res = await fetch(`https://api.mercadolibre.com/shipments/${shipId}/delays`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status === 404) {
        const { data: resolved } = await admin.from('ml_shipment_delays')
          .update({ status: 'auto_resolved', resolved_at: new Date().toISOString() })
          .eq('ml_shipment_id', shipId).eq('status', 'open').select('id')
        if (resolved?.length > 0) autoResolved += resolved.length
        continue
      }
      if (!res.ok) continue
      const body = await res.json()
      const delays = Array.isArray(body) ? body : (body.delays ?? [])
      for (const d of delays) {
        if (!['handling_delayed', 'sla_delayed', 'transit_delayed'].includes(d.type)) continue
        const { error } = await admin.from('ml_shipment_delays').upsert({
          organization_id: orgId, seller_id: sellerId,
          ml_shipment_id: shipId, ml_order_id: orderId,
          delay_type: d.type, delay_days: d.delayed_days ?? null,
          expected_date: d.expected_date ?? null, actual_date: d.actual_date ?? null,
          status: 'open', raw_response: d, detected_at: new Date().toISOString(),
        }, { onConflict: 'ml_shipment_id,delay_type' })
        if (!error) delaysFound++
      }
    } catch (e) { /* ignore */ }
  }
  console.log(`  delays: checked=${seen.size} found=${delaysFound} auto_resolved=${autoResolved}`)

  // ── 2. scanFlex
  const { data: items } = await admin.from('ml_quality_snapshots')
    .select('ml_item_id, product_id')
    .eq('organization_id', orgId).eq('seller_id', sellerId).limit(FLEX_BATCH)
  let flexElig = 0, flexChecked = 0
  let i = 0
  for (const it of (items ?? [])) {
    i++
    if (i % 50 === 0) console.log(`    flex progresso ${i}/${items.length}`)
    try {
      const res = await fetch(`https://api.mercadolibre.com/flex/sites/MLB/items/${it.ml_item_id}/v2`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) continue
      const body = await res.json()
      const hasFlex = body.has_flex === true
      if (hasFlex) flexElig++
      flexChecked++
      await admin.from('ml_flex_status').upsert({
        organization_id: orgId, seller_id: sellerId,
        ml_item_id: it.ml_item_id, product_id: it.product_id,
        has_flex: hasFlex, raw_response: body, fetched_at: new Date().toISOString(),
      }, { onConflict: 'organization_id,seller_id,ml_item_id' })
      await new Promise(r => setTimeout(r, FLEX_PAUSE_MS))
    } catch (e) { /* ignore */ }
  }
  console.log(`  flex: checked=${flexChecked} eligible=${flexElig}`)

  // ── 3. refreshSummary (counts)
  const today = new Date().toISOString().slice(0, 10) + 'T00:00:00Z'
  const cnt = async (table, filters, gteCol, gteVal) => {
    let q = admin.from(table).select('*', { count: 'exact', head: true })
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v)
    if (gteCol) q = q.gte(gteCol, gteVal)
    const { count } = await q
    return count ?? 0
  }
  const [toDispatch, dispatched, delivered, openDel, openH, openS, openT, fE, fT, iT] = await Promise.all([
    cnt('orders', { organization_id: orgId, seller_id: sellerId, platform: 'mercadolivre', shipping_status: 'ready_to_ship' }),
    cnt('orders', { organization_id: orgId, seller_id: sellerId, platform: 'mercadolivre', shipping_status: 'shipped' }, 'updated_at', today),
    cnt('orders', { organization_id: orgId, seller_id: sellerId, platform: 'mercadolivre', shipping_status: 'delivered' }, 'updated_at', today),
    cnt('ml_shipment_delays', { organization_id: orgId, seller_id: sellerId, status: 'open' }),
    cnt('ml_shipment_delays', { organization_id: orgId, seller_id: sellerId, status: 'open', delay_type: 'handling_delayed' }),
    cnt('ml_shipment_delays', { organization_id: orgId, seller_id: sellerId, status: 'open', delay_type: 'sla_delayed' }),
    cnt('ml_shipment_delays', { organization_id: orgId, seller_id: sellerId, status: 'open', delay_type: 'transit_delayed' }),
    cnt('ml_flex_status', { organization_id: orgId, seller_id: sellerId, has_flex: true }),
    cnt('ml_flex_status', { organization_id: orgId, seller_id: sellerId }),
    cnt('ml_quality_snapshots', { organization_id: orgId, seller_id: sellerId }),
  ])
  await admin.from('ml_logistics_summary').upsert({
    organization_id: orgId, seller_id: sellerId,
    shipments_to_dispatch_today: toDispatch,
    shipments_dispatched_today: dispatched,
    shipments_delivered_today: delivered,
    open_delays_count: openDel,
    open_delays_handling: openH, open_delays_sla: openS, open_delays_transit: openT,
    flex_eligible_count: fE,
    flex_scan_coverage_pct: iT > 0 ? Math.round((fT / iT) * 1000) / 10 : 0,
    last_synced_at: new Date().toISOString(),
    next_sync_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }, { onConflict: 'organization_id,seller_id' })

  console.log(`  summary: dispatch=${toDispatch} late=${openDel} flex_elig=${fE} cov=${iT > 0 ? ((fT/iT)*100).toFixed(1) : 0}%`)
}

console.log('\n[seed] done')
