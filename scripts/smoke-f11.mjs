#!/usr/bin/env node
/**
 * Smoke test — Sprint 0 do F11 ML Executive Dashboard IA.
 *
 * Valida shape dos 4 endpoints ML novos antes de criar migration foundation:
 *   1. /users/{id}                                    (seller_reputation)
 *   2. /users/{id}/items_visits?date_from&date_to     (visitas no periodo)
 *   3. /shipments/{id}/delays                         (atrasos — 404 esperado p/ a maioria)
 *   4. /flex/sites/MLB/items/{id}/v2                  (has_flex / flex_active)
 *
 * Roda contra Vazzo VAZZO_ (seller 2290161131). Refresh token se expirado.
 * Output salvo em /tmp/smoke-f11-output.json pra referencia.
 *
 * Uso:
 *   node scripts/smoke-f11.mjs
 *
 * Pre-req env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ML_CLIENT_ID, ML_CLIENT_SECRET.
 */
import fs   from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config }        from 'dotenv'
import { createClient }  from '@supabase/supabase-js'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA_URL = process.env.SUPABASE_URL
const SVC_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY
const ML_CLIENT_ID     = process.env.ML_CLIENT_ID
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET

if (!SUPA_URL || !SVC_KEY || !ML_CLIENT_ID || !ML_CLIENT_SECRET) {
  console.error('[smoke] env missing: SUPABASE_URL/KEY ou ML_CLIENT_ID/SECRET')
  process.exit(1)
}

const ORG_ID    = '4ef1aabd-c209-40b0-b034-ef69dcb66833'  // Vazzo
const SELLER_ID = 2290161131                                // VAZZO_

const admin = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } })

// ── Token resolve + refresh ──────────────────────────────────────────────
const { data: conn, error: connErr } = await admin
  .from('ml_connections')
  .select('seller_id, access_token, refresh_token, expires_at, nickname')
  .eq('organization_id', ORG_ID)
  .eq('seller_id', SELLER_ID)
  .maybeSingle()

if (connErr || !conn) {
  console.error('[smoke] ml_connection nao encontrada:', connErr?.message)
  process.exit(1)
}

let token = conn.access_token
const expired = new Date(conn.expires_at) <= new Date(Date.now() + 60_000)

if (expired) {
  console.log('[smoke] token expirado, fazendo refresh...')
  const refreshRes = await fetch('https://api.mercadolibre.com/oauth/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: conn.refresh_token,
    }),
  })
  if (!refreshRes.ok) {
    console.error('[smoke] refresh falhou:', refreshRes.status, await refreshRes.text())
    process.exit(1)
  }
  const refreshed = await refreshRes.json()
  token = refreshed.access_token
  await admin
    .from('ml_connections')
    .update({
      access_token:  refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at:    new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
      updated_at:    new Date().toISOString(),
    })
    .eq('organization_id', ORG_ID)
    .eq('seller_id', SELLER_ID)
  console.log('[smoke] token refreshed ok')
}

// ── Pega 1 item ativo qualquer pra sample (usado em /flex) ───────────────
const itemsSearchRes = await fetch(
  `https://api.mercadolibre.com/users/${SELLER_ID}/items/search?status=active&limit=3`,
  { headers: { Authorization: `Bearer ${token}` } },
)
if (!itemsSearchRes.ok) {
  console.error('[smoke] busca de items falhou:', itemsSearchRes.status)
  process.exit(1)
}
const itemsData    = await itemsSearchRes.json()
const sampleIds    = itemsData.results ?? []
if (sampleIds.length === 0) {
  console.error('[smoke] seller sem items ativos')
  process.exit(1)
}
const sampleItemId = sampleIds[0]
console.log(`[smoke] sample item: ${sampleItemId} (${itemsData.paging?.total ?? '?'} ativos)\n`)

// ── Pega 5 shipments recentes pra testar /delays (esperado 404 em maioria) ─
const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
const ordersRes = await fetch(
  `https://api.mercadolibre.com/orders/search?seller=${SELLER_ID}` +
  `&order.date_created.from=${encodeURIComponent(since)}&sort=date_desc&limit=20`,
  { headers: { Authorization: `Bearer ${token}` } },
)
const ordersData    = ordersRes.ok ? await ordersRes.json() : { results: [] }
const sampleShipIds = (ordersData.results ?? [])
  .map((o) => o.shipping?.id)
  .filter(Boolean)
  .slice(0, 5)
console.log(`[smoke] sample shipments p/ testar /delays: ${sampleShipIds.length} ids\n`)

// ── Helper de chamada ────────────────────────────────────────────────────
async function probe(name, url) {
  const t0 = Date.now()
  try {
    const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const ms   = Date.now() - t0
    const text = await res.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }

    console.log('━'.repeat(70))
    console.log(`▸ ${name}`)
    console.log(`  URL: ${url}`)
    console.log(`  HTTP ${res.status} (${ms}ms)`)

    if (res.status === 404) {
      console.log('  ⚠ 404 — esperado em /delays quando sem atraso, ou endpoint inexistente')
    } else if (res.status >= 400) {
      console.log(`  ✗ erro: ${typeof body === 'object' ? JSON.stringify(body, null, 2) : String(body).slice(0, 500)}`)
    } else {
      const preview = typeof body === 'object'
        ? JSON.stringify(body, null, 2)
        : String(body).slice(0, 1500)
      console.log('  ✓ shape:')
      console.log('  ' + preview.split('\n').slice(0, 80).join('\n  '))
      if (preview.length > 3000) console.log('  ... (truncado p/ stdout — JSON completo em /tmp/smoke-f11-output.json)')
    }
    console.log()
    return { name, url, status: res.status, ok: res.ok, body, ms }
  } catch (err) {
    console.log(`  ✗ exception: ${err.message}\n`)
    return { name, url, status: 0, ok: false, error: err.message }
  }
}

// ── 4 endpoints (com /delays multiplicado por N shipments) ───────────────
console.log('═'.repeat(70))
console.log(`F11 SMOKE TEST · seller ${SELLER_ID} (${conn.nickname ?? '?'}) · ${new Date().toISOString()}`)
console.log('═'.repeat(70))
console.log()

const results = []

// 1) /users/{id} — seller_reputation
results.push(await probe(
  '1. /users/{id} — seller_reputation + transactions',
  `https://api.mercadolibre.com/users/${SELLER_ID}`,
))

// 2) /users/{id}/items_visits — visitas no periodo (ultimos 7d)
const dateFrom = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
const dateTo   = new Date().toISOString()
results.push(await probe(
  '2. /users/{id}/items_visits?date_from&date_to — visitas 7d',
  `https://api.mercadolibre.com/users/${SELLER_ID}/items_visits` +
  `?date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(dateTo)}`,
))

// 2b) /users/{id}/items_visits/time_window — variante alternativa (rolling)
results.push(await probe(
  '2b. /users/{id}/items_visits/time_window?last=7&unit=day — variante',
  `https://api.mercadolibre.com/users/${SELLER_ID}/items_visits/time_window?last=7&unit=day`,
))

// 3) /shipments/{id}/delays — uma chamada por shipment_id sample
for (const shipId of sampleShipIds) {
  results.push(await probe(
    `3. /shipments/${shipId}/delays`,
    `https://api.mercadolibre.com/shipments/${shipId}/delays`,
  ))
}

// 4) /flex/sites/MLB/items/{id}/v2 — has_flex / flex_active
results.push(await probe(
  '4. /flex/sites/MLB/items/{id}/v2 — has_flex',
  `https://api.mercadolibre.com/flex/sites/MLB/items/${sampleItemId}/v2`,
))

// ── Sumario ──────────────────────────────────────────────────────────────
console.log('═'.repeat(70))
console.log('RESUMO')
console.log('═'.repeat(70))
for (const r of results) {
  const icon = r.ok ? '✓' : (r.status === 404 ? '⚠' : '✗')
  console.log(`${icon} ${r.status}  ${r.name}`)
}
const okCount = results.filter(r => r.ok).length
console.log(`\n${okCount}/${results.length} respostas 2xx`)

// ── Salva JSON completo pra referencia ────────────────────────────────────
const outPath = process.platform === 'win32'
  ? path.resolve(here, '..', 'smoke-f11-output.json')
  : '/tmp/smoke-f11-output.json'
fs.writeFileSync(outPath, JSON.stringify({
  ran_at:    new Date().toISOString(),
  seller_id: SELLER_ID,
  nickname:  conn.nickname,
  sample_item_id:    sampleItemId,
  sample_shipments:  sampleShipIds,
  results,
}, null, 2))
console.log(`\nJSON completo salvo em: ${outPath}`)

process.exit(okCount === results.length ? 0 : 1)
