#!/usr/bin/env node
/**
 * Seed inicial pra F11 Fase 2 — visitas por item.
 *
 * Replica VisitsScannerService.scanSeller standalone (sem NestJS):
 *   - Token via ml_connections (refresh se expirado)
 *   - Items ativos: ml_quality_snapshots fetched_at >= now-7d, distinct ml_item_id
 *   - GET /items/{id}/visits/time_window?last=7&unit=day per item
 *   - Retry matrix: 200 ok, 401 refresh, 404/410 skip, 429 cooldown, 5xx backoff
 *   - Upsert em ml_item_visits_period (ON CONFLICT idempotente com cron Nest)
 *
 * Rate-limit ~1/s. ~425 items Vazzo (382 VAZZO_ + 43 ESLAR_) ≈ 7 min.
 *
 * Uso:
 *   node scripts/seed-f11-item-visits.mjs [ORG_UUID] [PERIOD_DAYS=7]
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
  console.error('[seed] env missing: SUPABASE_URL/KEY ou ML_CLIENT_ID/SECRET')
  process.exit(1)
}

const admin = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } })

const targetOrg = process.argv[2] ?? '4ef1aabd-c209-40b0-b034-ef69dcb66833'
const PERIOD_DAYS = Number(process.argv[3] ?? 7)

const RATE_LIMIT_MS = 1000
const MAX_RETRIES   = 3
const MAX_ITEMS_PER_SELLER = 2000

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

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
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: new Date(Date.now() + j.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('organization_id', conn.organization_id).eq('seller_id', conn.seller_id)
  return j.access_token
}

async function getToken(orgId, sellerId) {
  const { data: conn, error } = await admin
    .from('ml_connections')
    .select('organization_id, seller_id, access_token, refresh_token, expires_at')
    .eq('organization_id', orgId).eq('seller_id', sellerId).maybeSingle()
  if (error || !conn) throw new Error(`no_token: org=${orgId} seller=${sellerId}`)
  if (new Date(conn.expires_at) <= new Date(Date.now() + 60_000)) {
    return await refreshToken(conn)
  }
  return conn.access_token
}

async function upsertVisits(ctx, fields) {
  const { error } = await admin.from('ml_item_visits_period').upsert({
    organization_id: ctx.orgId,
    seller_id:       ctx.sellerId,
    ml_item_id:      ctx.itemId,
    period_days:     ctx.periodDays,
    period_start:    ctx.periodStart,
    period_end:      ctx.periodEnd,
    total_visits:    fields.totalVisits,
    daily_breakdown: fields.dailyBreakdown,
    last_synced_at:  new Date().toISOString(),
    sync_source:     'ml_api_v1',
    http_status:     fields.httpStatus,
    error_message:   fields.errorMessage,
  }, {
    onConflict: 'organization_id,seller_id,ml_item_id,period_days,period_end',
  })
  if (error) console.warn(`    ✗ upsert ${ctx.itemId}: ${error.message}`)
}

async function scanItem(ctx, initialToken) {
  let attempt = 0
  let token = initialToken
  while (attempt < MAX_RETRIES) {
    try {
      const url = `https://api.mercadolibre.com/items/${ctx.itemId}/visits/time_window?last=${ctx.periodDays}&unit=day`
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (r.ok) {
        const body = await r.json()
        await upsertVisits(ctx, {
          httpStatus: r.status,
          totalVisits: body.total_visits ?? 0,
          dailyBreakdown: body.results ?? [],
          errorMessage: null,
        })
        return { ok: true, status: r.status, visits: body.total_visits ?? 0 }
      }
      if (r.status === 404 || r.status === 410) {
        await upsertVisits(ctx, { httpStatus: r.status, totalVisits: 0, dailyBreakdown: [], errorMessage: 'item_not_found' })
        return { ok: false, status: r.status, error: 'item_not_found' }
      }
      if (r.status === 401) {
        console.warn(`    401 ${ctx.itemId} — refreshing token`)
        token = await getToken(ctx.orgId, ctx.sellerId)
        continue
      }
      if (r.status === 429) {
        console.warn(`    429 ${ctx.itemId} — cooldown 60s`)
        await sleep(60_000)
        continue
      }
      // 5xx / outros: backoff exponencial
      attempt++
      if (attempt < MAX_RETRIES) {
        const backoff = Math.min(1000 * Math.pow(5, attempt), 30_000)
        await sleep(backoff)
      } else {
        const text = await r.text().catch(() => '')
        await upsertVisits(ctx, { httpStatus: r.status, totalVisits: 0, dailyBreakdown: [], errorMessage: `http_${r.status}` })
        return { ok: false, status: r.status, error: text.slice(0, 80) }
      }
    } catch (err) {
      attempt++
      if (attempt < MAX_RETRIES) {
        const backoff = Math.min(1000 * Math.pow(5, attempt), 30_000)
        await sleep(backoff)
      } else {
        await upsertVisits(ctx, { httpStatus: 0, totalVisits: 0, dailyBreakdown: [], errorMessage: err.message })
        return { ok: false, status: 0, error: err.message }
      }
    }
  }
  return { ok: false, status: 0, error: 'max_retries' }
}

async function scanSeller(orgId, sellerId, periodDays) {
  const start = Date.now()

  let token
  try { token = await getToken(orgId, sellerId) }
  catch (e) { console.error(`[seed] ✗ token seller=${sellerId}: ${e.message}`); return null }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data: items } = await admin
    .from('ml_quality_snapshots')
    .select('ml_item_id')
    .eq('organization_id', orgId)
    .eq('seller_id', sellerId)
    .gte('fetched_at', sevenDaysAgo)
  const unique = Array.from(new Set((items ?? []).map(i => i.ml_item_id).filter(Boolean))).slice(0, MAX_ITEMS_PER_SELLER)

  console.log(`\n[seed] seller=${sellerId} items=${unique.length} period=${periodDays}d`)

  const today = new Date()
  const periodEndDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  const periodStartDate = new Date(periodEndDate.getTime() - periodDays * 24 * 60 * 60 * 1000)
  const periodEnd   = periodEndDate.toISOString().slice(0, 10)
  const periodStart = periodStartDate.toISOString().slice(0, 10)

  const stats = { items_total: unique.length, success: 0, skipped: 0, failed: 0, errorsByStatus: {} }

  let i = 0
  for (const itemId of unique) {
    i++
    if (i % 50 === 0) {
      const elapsed = Math.round((Date.now() - start) / 1000)
      console.log(`  progress ${i}/${unique.length} (${elapsed}s · ok=${stats.success} skip=${stats.skipped} fail=${stats.failed})`)
    }
    const ctx = { orgId, sellerId, itemId, periodDays, periodStart, periodEnd }
    const r = await scanItem(ctx, token)
    if (r.ok) stats.success++
    else if (r.status === 404 || r.status === 410) stats.skipped++
    else stats.failed++
    if (r.status) stats.errorsByStatus[r.status] = (stats.errorsByStatus[r.status] ?? 0) + 1
    await sleep(RATE_LIMIT_MS)
  }

  const durationS = Math.round((Date.now() - start) / 1000)
  console.log(`  done seller=${sellerId} ok=${stats.success} skipped=${stats.skipped} failed=${stats.failed} duration=${durationS}s`)
  if (Object.keys(stats.errorsByStatus).length > 0) {
    console.log(`  errorsByStatus: ${JSON.stringify(stats.errorsByStatus)}`)
  }
  return { sellerId, ...stats, durationS }
}

// ─── Main ──────────────────────────────────────────────────────────
const { data: conns } = await admin
  .from('ml_connections')
  .select('seller_id')
  .eq('organization_id', targetOrg)
const sellers = (conns ?? []).map(c => c.seller_id).filter(Boolean)
console.log(`[seed] org=${targetOrg.slice(0, 8)} sellers=${sellers.join(',')} periodDays=${PERIOD_DAYS}`)

const results = []
for (const sellerId of sellers) {
  const r = await scanSeller(targetOrg, sellerId, PERIOD_DAYS)
  if (r) results.push(r)
}

console.log('\n══════════════════════════════════════════════════════')
console.log('RESUMO FINAL')
console.log('══════════════════════════════════════════════════════')
for (const r of results) {
  console.log(`seller=${r.sellerId} items_total=${r.items_total} success=${r.success} skipped=${r.skipped} failed=${r.failed} duration=${r.durationS}s`)
}
const totalOk      = results.reduce((s, r) => s + r.success, 0)
const totalSkip    = results.reduce((s, r) => s + r.skipped, 0)
const totalFail    = results.reduce((s, r) => s + r.failed, 0)
const totalItems   = results.reduce((s, r) => s + r.items_total, 0)
console.log(`TOTAL: ${totalOk}/${totalItems} ok, ${totalSkip} skipped, ${totalFail} failed`)

process.exit(totalFail > totalItems / 4 ? 1 : 0)  // fail se >25% items falharam
