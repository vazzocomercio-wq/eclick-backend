#!/usr/bin/env node
/**
 * Smoke test — Sprint 0 do F10 ML Listing Center.
 * Valida shape dos 5 endpoints novos antes de criar migrations:
 *   1. /suggestions/user/{seller}/items       (lista itens c/ sugestão)
 *   2. /suggestions/items/{item_id}            (sugestão de 1 item)
 *   3. /pricing-automation/items/{id}/rules    (regras disponíveis)
 *   4. /pricing-automation/items/{id}/automation (status atual)
 *   5. /pricing-automation/users/{seller}/items (todos automatizados)
 *
 * Roda contra Vazzo VAZZO_ (seller 2290161131). Faz refresh do token
 * se expirado (igual MercadolivreService.refreshIfNeeded faz).
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
  console.error('[smoke] env missing: SUPABASE_URL/KEY ou ML_CLIENT_ID/SECRET')
  process.exit(1)
}

const ORG_ID    = '4ef1aabd-c209-40b0-b034-ef69dcb66833'  // Vazzo
const SELLER_ID = 2290161131                                // VAZZO_

const admin = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } })

// ── Token resolve + refresh ──────────────────────────────────────────────
const { data: conn, error: connErr } = await admin
  .from('ml_connections')
  .select('seller_id, access_token, refresh_token, expires_at')
  .eq('organization_id', ORG_ID)
  .eq('seller_id', SELLER_ID)
  .maybeSingle()

if (connErr || !conn) {
  console.error('[smoke] ml_connection não encontrada:', connErr?.message)
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

// Pega 1 item ativo qualquer pra usar como sample
const itemsSearchRes = await fetch(
  `https://api.mercadolibre.com/users/${SELLER_ID}/items/search?status=active&limit=3`,
  { headers: { Authorization: `Bearer ${token}` } },
)
if (!itemsSearchRes.ok) {
  console.error('[smoke] busca de items falhou:', itemsSearchRes.status)
  process.exit(1)
}
const itemsData  = await itemsSearchRes.json()
const sampleIds  = itemsData.results ?? []
if (sampleIds.length === 0) {
  console.error('[smoke] seller sem items ativos')
  process.exit(1)
}
const sampleItemId = sampleIds[0]
console.log(`[smoke] sample item pra testes: ${sampleItemId} (de ${itemsData.paging?.total ?? '?'} ativos)\n`)

// ── Helper de chamada ────────────────────────────────────────────────────
async function probe(name, url) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const ms  = Date.now() - t0
    const text = await res.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }

    console.log('━'.repeat(70))
    console.log(`▸ ${name}`)
    console.log(`  URL: ${url}`)
    console.log(`  HTTP ${res.status} (${ms}ms)`)

    if (res.status === 404) {
      console.log('  ⚠ 404 — endpoint pode não existir, OU sem dados pra esse seller/item')
    } else if (res.status >= 400) {
      console.log(`  ✗ erro: ${typeof body === 'object' ? JSON.stringify(body, null, 2) : body.slice(0, 500)}`)
    } else {
      const preview = typeof body === 'object'
        ? JSON.stringify(body, null, 2)
        : String(body).slice(0, 1500)
      console.log('  ✓ shape:')
      console.log('  ' + preview.split('\n').slice(0, 60).join('\n  '))
      if (preview.length > 1500) console.log('  ... (truncado)')
    }
    console.log()
    return { name, status: res.status, ok: res.ok, body, ms }
  } catch (err) {
    console.log(`  ✗ exception: ${err.message}\n`)
    return { name, status: 0, ok: false, error: err.message }
  }
}

// ── 5 endpoints ──────────────────────────────────────────────────────────
console.log('═'.repeat(70))
console.log(`F10 SMOKE TEST · seller ${SELLER_ID} · ${new Date().toISOString()}`)
console.log('═'.repeat(70))
console.log()

const results = []
results.push(await probe(
  '1. /suggestions/user/{seller}/items — lista itens com sugestão',
  `https://api.mercadolibre.com/suggestions/user/${SELLER_ID}/items`,
))
results.push(await probe(
  '2. /suggestions/items/{id} — sugestão de 1 item',
  `https://api.mercadolibre.com/suggestions/items/${sampleItemId}`,
))
results.push(await probe(
  '3. /pricing-automation/items/{id}/rules — regras disponíveis',
  `https://api.mercadolibre.com/pricing-automation/items/${sampleItemId}/rules`,
))
results.push(await probe(
  '4. /pricing-automation/items/{id}/automation — status atual',
  `https://api.mercadolibre.com/pricing-automation/items/${sampleItemId}/automation`,
))
results.push(await probe(
  '5. /pricing-automation/users/{seller}/items — itens automatizados',
  `https://api.mercadolibre.com/pricing-automation/users/${SELLER_ID}/items`,
))

// ── Sumário ──────────────────────────────────────────────────────────────
console.log('═'.repeat(70))
console.log('RESUMO')
console.log('═'.repeat(70))
for (const r of results) {
  const icon = r.ok ? '✓' : (r.status === 404 ? '⚠' : '✗')
  console.log(`${icon} ${r.status}  ${r.name}`)
}
const okCount = results.filter(r => r.ok).length
console.log(`\n${okCount}/5 endpoints respondendo 2xx`)
process.exit(okCount === 5 ? 0 : 1)
