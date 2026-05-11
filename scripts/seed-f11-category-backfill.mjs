#!/usr/bin/env node
/**
 * Backfill F11 Fase 2 — products.category_ml_id NULL → categoria ML.
 *
 * Lógica:
 *   1. Lista products WHERE category_ml_id IS NULL (em uma org)
 *   2. Pra cada product, acha 1 listing ativo (platform=mercadolivre, is_active=true)
 *   3. GET /items/{listing_id}?attributes=category_id (payload mínimo)
 *   4. UPDATE products.category_ml_id
 *
 * Matriz de retry idêntica ao seed-f11-item-visits.mjs:
 *   200 ok · 404/410 skip · 401 refresh · 429 cooldown 60s · 5xx backoff
 *
 * Token: GET /items/{id} EXIGE token do owner (testado 2026-05-11 — V2025
 * token deu 403 pra items VAZZO_). Mapeia product → ml_quality_snapshots
 * (que tem seller_id correto pra cada item) e usa o token daquele seller.
 * Cache de tokens por seller_id pra evitar re-fetch.
 *
 * Uso:
 *   node scripts/seed-f11-category-backfill.mjs [ORG_UUID]
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

const RATE_LIMIT_MS = 1000
const MAX_RETRIES   = 3

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

async function getSellerToken(orgId, sellerId) {
  const { data: conn, error } = await admin
    .from('ml_connections')
    .select('organization_id, seller_id, access_token, refresh_token, expires_at')
    .eq('organization_id', orgId)
    .eq('seller_id', sellerId)
    .maybeSingle()
  if (error || !conn) throw new Error(`no token for org=${orgId} seller=${sellerId}`)
  if (new Date(conn.expires_at) <= new Date(Date.now() + 60_000)) {
    return await refreshToken(conn)
  }
  return conn.access_token
}

// ─── Main ──────────────────────────────────────────────────────────
console.log(`[seed] org=${targetOrg.slice(0, 8)}`)

// 1. Lista products sem categoria
const { data: products, error: pErr } = await admin
  .from('products')
  .select('id')
  .eq('organization_id', targetOrg)
  .is('category_ml_id', null)
if (pErr) { console.error(`[seed] list products: ${pErr.message}`); process.exit(1) }
console.log(`[seed] ${products.length} products sem category_ml_id`)

if (products.length === 0) {
  console.log('[seed] nada pra backfillar — exit 0')
  process.exit(0)
}

// 2. Mapear product → ml_item_id → seller_id
// product_listings.account_id é NULL em 100% das linhas + ml_quality_snapshots.product_id também NULL
// JOIN: product_listings.listing_id ↔ ml_quality_snapshots.ml_item_id (ambos = MLB-id)
const productIds = products.map(p => p.id)
const targets = []
const productClaimed = new Set()

// 2a. Pra cada product, listing(s) ativos com listing_id
const BATCH = 200
const productToListings = new Map()  // product_id → [listing_id, ...]
const allListingIds = []
for (let i = 0; i < productIds.length; i += BATCH) {
  const slice = productIds.slice(i, i + BATCH)
  const { data: listings } = await admin
    .from('product_listings')
    .select('product_id, listing_id, created_at')
    .in('product_id', slice)
    .eq('platform', 'mercadolivre')
    .eq('is_active', true)
    .not('listing_id', 'is', null)
    .order('created_at', { ascending: false })
  for (const l of (listings ?? [])) {
    if (!productToListings.has(l.product_id)) productToListings.set(l.product_id, [])
    productToListings.get(l.product_id).push(l.listing_id)
    allListingIds.push(l.listing_id)
  }
}
console.log(`[seed] ${productToListings.size}/${products.length} products têm pelo menos 1 listing ML ativo`)

// 2b. Pegar seller_id de cada listing via ml_quality_snapshots
const listingToSeller = new Map()  // listing_id → seller_id (do snapshot mais recente)
const uniqueListings = Array.from(new Set(allListingIds))
for (let i = 0; i < uniqueListings.length; i += BATCH) {
  const slice = uniqueListings.slice(i, i + BATCH)
  const { data: snaps } = await admin
    .from('ml_quality_snapshots')
    .select('ml_item_id, seller_id, fetched_at')
    .eq('organization_id', targetOrg)
    .in('ml_item_id', slice)
    .order('fetched_at', { ascending: false })
  for (const s of (snaps ?? [])) {
    if (listingToSeller.has(s.ml_item_id)) continue
    listingToSeller.set(s.ml_item_id, s.seller_id)
  }
}
console.log(`[seed] ${listingToSeller.size}/${uniqueListings.length} listings têm seller mapeado via snapshots`)

// 2c. Pra cada product, pegar 1 listing com seller resolvido
for (const [pid, listings] of productToListings) {
  for (const listingId of listings) {
    const sellerId = listingToSeller.get(listingId)
    if (sellerId && !productClaimed.has(pid)) {
      targets.push({ product_id: pid, ml_item_id: listingId, seller_id: sellerId })
      productClaimed.add(pid)
      break
    }
  }
}
console.log(`[seed] ${targets.length}/${products.length} products têm mapeamento completo (${products.length - targets.length} sem — skip permanente)`)

// Cache de tokens por seller_id
const tokenCache = new Map()
async function tokenFor(sellerId) {
  if (tokenCache.has(sellerId)) return tokenCache.get(sellerId)
  const t = await getSellerToken(targetOrg, sellerId)
  tokenCache.set(sellerId, t)
  return t
}
async function refreshTokenFor(sellerId) {
  tokenCache.delete(sellerId)
  return tokenFor(sellerId)
}
// Distribuição por seller (info)
const distrib = {}
for (const t of targets) distrib[t.seller_id] = (distrib[t.seller_id] ?? 0) + 1
console.log(`[seed] distribuição por seller: ${JSON.stringify(distrib)}`)

// 3. Loop com rate-limit + retry
const stats = { total: targets.length, success: 0, skipped: 0, failed: 0, errorsByStatus: {} }
const start = Date.now()

for (let i = 0; i < targets.length; i++) {
  const t = targets[i]
  if ((i + 1) % 50 === 0) {
    const elapsed = Math.round((Date.now() - start) / 1000)
    console.log(`  progress ${i + 1}/${targets.length} (${elapsed}s · ok=${stats.success} skip=${stats.skipped} fail=${stats.failed})`)
  }

  let attempt = 0
  let resolved = false
  let currentToken = await tokenFor(t.seller_id)
  while (attempt < MAX_RETRIES && !resolved) {
    try {
      const url = `https://api.mercadolibre.com/items/${t.ml_item_id}?attributes=category_id`
      const r = await fetch(url, { headers: { Authorization: `Bearer ${currentToken}` } })

      if (r.ok) {
        const body = await r.json()
        const categoryId = body?.category_id
        if (!categoryId) {
          stats.skipped++
          stats.errorsByStatus['no_category'] = (stats.errorsByStatus['no_category'] ?? 0) + 1
          resolved = true
          break
        }
        const { error: updErr } = await admin
          .from('products')
          .update({ category_ml_id: categoryId })
          .eq('id', t.product_id)
        if (updErr) {
          stats.failed++
          stats.errorsByStatus['update_failed'] = (stats.errorsByStatus['update_failed'] ?? 0) + 1
        } else {
          stats.success++
        }
        resolved = true
        break
      }

      if (r.status === 404 || r.status === 410 || r.status === 403) {
        // 403 = token sem permissão (raro com token do owner certo, mas defensive)
        stats.skipped++
        stats.errorsByStatus[r.status] = (stats.errorsByStatus[r.status] ?? 0) + 1
        resolved = true
        break
      }
      if (r.status === 401) {
        console.warn(`    401 ${t.ml_item_id} seller=${t.seller_id} — refreshing token`)
        currentToken = await refreshTokenFor(t.seller_id)
        continue
      }
      if (r.status === 429) {
        console.warn(`    429 ${t.ml_item_id} — cooldown 60s`)
        await sleep(60_000)
        continue
      }
      // 5xx / outros
      attempt++
      if (attempt < MAX_RETRIES) {
        const backoff = Math.min(1000 * Math.pow(5, attempt), 30_000)
        await sleep(backoff)
      } else {
        stats.failed++
        stats.errorsByStatus[r.status] = (stats.errorsByStatus[r.status] ?? 0) + 1
        resolved = true
      }
    } catch (err) {
      attempt++
      if (attempt < MAX_RETRIES) {
        await sleep(Math.min(1000 * Math.pow(5, attempt), 30_000))
      } else {
        stats.failed++
        stats.errorsByStatus['exception'] = (stats.errorsByStatus['exception'] ?? 0) + 1
        resolved = true
      }
    }
  }

  await sleep(RATE_LIMIT_MS)
}

const durationS = Math.round((Date.now() - start) / 1000)
console.log('\n══════════════════════════════════════════════════════')
console.log('RESUMO FINAL')
console.log('══════════════════════════════════════════════════════')
console.log(`Products processados: ${stats.total}`)
console.log(`  success:  ${stats.success}`)
console.log(`  skipped:  ${stats.skipped} (sem category_id no ML / item morto)`)
console.log(`  failed:   ${stats.failed}`)
console.log(`  duration: ${durationS}s`)
if (Object.keys(stats.errorsByStatus).length > 0) {
  console.log(`  errors:   ${JSON.stringify(stats.errorsByStatus)}`)
}
process.exit(stats.failed > stats.total / 4 ? 1 : 0)
