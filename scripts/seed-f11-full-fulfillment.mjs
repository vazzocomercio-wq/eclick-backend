#!/usr/bin/env node
/**
 * Seed inicial pra F11 Fase 2 — Full Fulfillment inventory.
 *
 * Pattern parecido com seed-f11-item-visits.mjs (sellers da org, token cache,
 * rate-limit). Mas usa scroll pagination + batch /items pra eficiência.
 *
 * Endpoints ML:
 *   1. GET /users/{seller_id}/items/search?logistic_type=fulfillment&search_type=scan
 *      (scroll pagination, limit 100/page)
 *   2. GET /items?ids=MLB1,MLB2,...&attributes=id,status,sub_status,available_quantity,inventory_id,variations
 *      (batch até 20 IDs/chamada)
 *
 * Multi-conta: SEMPRE passa sellerId em getTokenForOrg.
 *
 * last_sold_at: vem de orders local (zero ML call extra).
 * variation_id: '' (string vazia) no MVP item-level — evita gotcha NULL no UPSERT.
 * Upsert pattern: DELETE WHERE captured_date=CURRENT_DATE + INSERT (UNIQUE index
 * usa COALESCE(variation_id,'') que não casa com onConflict do PostgREST).
 *
 * Uso:
 *   node scripts/seed-f11-full-fulfillment.mjs [ORG_UUID]
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
const targetOrg = process.argv[2] ?? '4ef1aabd-c209-40b0-b034-ef69dcb66833'

const RATE_LIMIT_MS = 500
const BATCH_SIZE    = 20

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function refreshToken(conn) {
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
  if (!r.ok) throw new Error(`refresh ${r.status}: ${await r.text()}`)
  const j = await r.json()
  await admin.from('ml_connections').update({
    access_token:  j.access_token,
    refresh_token: j.refresh_token,
    expires_at:    new Date(Date.now() + j.expires_in * 1000).toISOString(),
    updated_at:    new Date().toISOString(),
  }).eq('organization_id', conn.organization_id).eq('seller_id', conn.seller_id)
  return j.access_token
}

async function getToken(orgId, sellerId) {
  const { data: conn, error } = await admin
    .from('ml_connections')
    .select('organization_id, seller_id, access_token, refresh_token, expires_at, nickname')
    .eq('organization_id', orgId).eq('seller_id', sellerId).maybeSingle()
  if (error || !conn) throw new Error(`no_token: org=${orgId} seller=${sellerId}`)
  if (new Date(conn.expires_at) <= new Date(Date.now() + 60_000)) {
    return { token: await refreshToken(conn), nickname: conn.nickname }
  }
  return { token: conn.access_token, nickname: conn.nickname }
}

async function scanSeller(orgId, sellerId, nickname) {
  console.log(`\n[seed] seller=${sellerId} (${nickname ?? '?'}) scanning FULL...`)
  const start = Date.now()
  let { token } = await getToken(orgId, sellerId)

  const stats = { items_listed: 0, details_fetched: 0, inserted: 0, errors: 0 }

  // 1. Scroll pagination — lista todos IDs FULL deste seller
  const allIds = []
  let scrollId = null
  while (true) {
    const params = new URLSearchParams({
      logistic_type: 'fulfillment',
      search_type:   'scan',
      limit:         '100',
    })
    if (scrollId) params.set('scroll_id', scrollId)
    const url = `https://api.mercadolibre.com/users/${sellerId}/items/search?${params}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })

    if (res.status === 401) {
      const refreshed = await getToken(orgId, sellerId)
      token = refreshed.token
      continue
    }
    if (!res.ok) {
      console.warn(`  ✗ list ${res.status}: ${(await res.text()).slice(0, 120)}`)
      stats.errors++
      break
    }

    const body = await res.json()
    const ids = body?.results ?? []
    if (ids.length === 0) break
    allIds.push(...ids)
    scrollId = body?.scroll_id ?? null
    stats.items_listed = allIds.length
    if (stats.items_listed % 500 === 0) {
      console.log(`  listing progress ${stats.items_listed}…`)
    }
    if (!scrollId) break
    await sleep(RATE_LIMIT_MS)
  }
  console.log(`  total IDs FULL: ${allIds.length}`)

  if (allIds.length === 0) return { sellerId, ...stats, durationS: Math.round((Date.now() - start) / 1000) }

  // 2. Limpa dia atual pra evitar bug do UNIQUE com COALESCE(variation_id,'')
  // (não dá pra usar onConflict no PostgREST contra expression index).
  // captured_date é GENERATED — comparamos via subquery direta no DELETE.
  const todayISO = new Date().toISOString().slice(0, 10)
  const { error: delErr } = await admin
    .from('ml_fulfillment_inventory')
    .delete()
    .eq('organization_id', orgId)
    .eq('seller_id',       sellerId)
    .eq('captured_date',   todayISO)
  if (delErr) console.warn(`  ⚠ delete day failed: ${delErr.message}`)

  // 3. Batch /items + last_sold_at + INSERT
  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batch = allIds.slice(i, i + BATCH_SIZE)
    if ((i + BATCH_SIZE) % 100 === 0 || i + BATCH_SIZE >= allIds.length) {
      console.log(`  details progress ${Math.min(i + BATCH_SIZE, allIds.length)}/${allIds.length}`)
    }

    // 3a. /items?ids=...
    const url = `https://api.mercadolibre.com/items?ids=${batch.join(',')}&attributes=id,status,sub_status,available_quantity,inventory_id,variations`
    const detRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (detRes.status === 401) {
      const refreshed = await getToken(orgId, sellerId)
      token = refreshed.token
      i -= BATCH_SIZE
      continue
    }
    if (!detRes.ok) {
      console.warn(`  ✗ details ${detRes.status} batch ${i}`)
      stats.errors++
      continue
    }
    const items = await detRes.json()

    // 3b. last_sold_at de orders local (1 query por batch)
    const { data: salesRows } = await admin
      .from('orders')
      .select('marketplace_listing_id, created_at')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .eq('platform',        'mercadolivre')
      .eq('status',          'paid')
      .in('marketplace_listing_id', batch)
      .order('created_at', { ascending: false })
    const lastSoldMap = new Map()
    for (const r of (salesRows ?? [])) {
      if (!lastSoldMap.has(r.marketplace_listing_id)) {
        lastSoldMap.set(r.marketplace_listing_id, r.created_at)
      }
    }

    // 3c. Montar rows
    const rows = []
    for (const r of items) {
      if (r.code !== 200 || !r.body) continue
      const b = r.body
      rows.push({
        organization_id:        orgId,
        seller_id:              sellerId,
        item_id:                b.id,
        inventory_id:           b.inventory_id ?? null,
        variation_id:           '',                              // MVP item-level — string vazia
        status:                 b.status,
        sub_status:             Array.isArray(b.sub_status) ? b.sub_status : [],
        available_quantity:     b.available_quantity ?? 0,
        not_available_quantity: 0,
        last_sold_at:           lastSoldMap.get(b.id) ?? null,
        raw_payload:            b,
        captured_at:            new Date().toISOString(),
      })
      stats.details_fetched++
    }

    // 3d. INSERT (sem onConflict — DELETE do dia já limpou)
    if (rows.length > 0) {
      const { error: insErr } = await admin
        .from('ml_fulfillment_inventory')
        .insert(rows)
      if (insErr) {
        console.warn(`  ✗ insert batch ${i}: ${insErr.message}`)
        stats.errors++
      } else {
        stats.inserted += rows.length
      }
    }

    await sleep(RATE_LIMIT_MS)
  }

  const durationS = Math.round((Date.now() - start) / 1000)
  console.log(`  done seller=${sellerId} listed=${stats.items_listed} details=${stats.details_fetched} inserted=${stats.inserted} errors=${stats.errors} duration=${durationS}s`)
  return { sellerId, ...stats, durationS }
}

// ─── Main ──────────────────────────────────────────────────────────
console.log(`[seed] org=${targetOrg.slice(0, 8)}`)
const { data: conns } = await admin
  .from('ml_connections')
  .select('seller_id, nickname')
  .eq('organization_id', targetOrg)
const sellers = (conns ?? []).filter(c => c.seller_id)
console.log(`[seed] ${sellers.length} sellers: ${sellers.map(s => `${s.seller_id} (${s.nickname ?? '?'})`).join(', ')}`)

const results = []
for (const s of sellers) {
  try {
    const r = await scanSeller(targetOrg, s.seller_id, s.nickname)
    results.push(r)
  } catch (err) {
    console.error(`[seed] ✗ seller=${s.seller_id}: ${err.message}`)
  }
}

console.log('\n══════════════════════════════════════════════════════')
console.log('RESUMO FINAL')
console.log('══════════════════════════════════════════════════════')
for (const r of results) {
  console.log(`seller=${r.sellerId} listed=${r.items_listed} inserted=${r.inserted} errors=${r.errors} duration=${r.durationS}s`)
}
const totalInserted = results.reduce((s, r) => s + r.inserted, 0)
const totalErrors   = results.reduce((s, r) => s + r.errors,   0)
console.log(`TOTAL: ${totalInserted} items inserted, ${totalErrors} errors`)
process.exit(totalErrors > totalInserted / 4 ? 1 : 0)
