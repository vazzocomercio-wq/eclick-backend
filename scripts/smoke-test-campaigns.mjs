#!/usr/bin/env node
/**
 * Smoke test dos endpoints ML usados pelo F8 Campaign Center.
 *
 * Não tenta criar oferta real (POST/PUT/DELETE) — só valida shape de
 * resposta dos GETs. Pra POST/PUT/DELETE, validar manualmente quando
 * houver campanha pequena disponível pra teste.
 *
 * Uso: node scripts/smoke-test-campaigns.mjs
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA_URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
const ML_BASE = 'https://api.mercadolibre.com'

if (!SUPA_URL || !KEY) {
  console.error('FATAL: SUPABASE_URL/SECRET_KEY não setados')
  process.exit(1)
}

// ── 1. Pegar access_token da Vazzo do banco ─────────────────────────
async function getToken() {
  const url = `${SUPA_URL.replace(/\/+$/, '')}/rest/v1/rpc/_admin_query_sql`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey:        KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type':'application/json',
    },
    body: JSON.stringify({
      sql: `SELECT seller_id, access_token, nickname FROM ml_connections WHERE nickname = 'VAZZO_' LIMIT 1`,
    }),
  })
  const data = await res.json()
  return data.rows?.[0] ?? data[0]
}

const conn = await getToken()
if (!conn?.access_token) {
  console.error('FATAL: sem access_token na Vazzo')
  process.exit(1)
}

const TOKEN = conn.access_token
const SELLER_ID = conn.seller_id

console.log(`\n🧪 SMOKE TEST F8 — ML Campaigns endpoints`)
console.log(`   seller_id: ${SELLER_ID} (${conn.nickname})\n`)

// ── 2. Helpers ──────────────────────────────────────────────────────
async function ml(method, path, params = null, body = null) {
  const url = new URL(`${ML_BASE}${path}`)
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))

  const headers = { Authorization: `Bearer ${TOKEN}` }
  if (body) headers['Content-Type'] = 'application/json'

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, ok: res.ok, body: json, raw: text }
}

function logResult(label, result, sampleKeys = []) {
  const status = result.status
  const ok = result.ok
  const symbol = ok ? '✅' : status === 404 ? '⚠️' : '❌'
  console.log(`${symbol} [${status}] ${label}`)

  if (!ok) {
    console.log(`   error: ${typeof result.body === 'object' ? JSON.stringify(result.body).slice(0, 250) : String(result.body).slice(0, 250)}`)
    return
  }

  // Sample shape
  const data = result.body
  if (Array.isArray(data)) {
    console.log(`   array: ${data.length} items`)
    if (data.length > 0 && sampleKeys.length > 0) {
      const first = data[0]
      const keys = sampleKeys.map(k => `${k}=${JSON.stringify(first[k])?.slice(0,40)}`).join(' | ')
      console.log(`   first: ${keys}`)
    } else if (data.length > 0) {
      console.log(`   first keys: ${Object.keys(data[0] ?? {}).slice(0, 8).join(', ')}`)
    }
  } else if (data && typeof data === 'object') {
    if (data.results) {
      console.log(`   results: ${data.results.length} items, paging=${JSON.stringify(data.paging ?? {})}`)
      if (data.results.length > 0) {
        const first = data.results[0]
        if (sampleKeys.length > 0) {
          const keys = sampleKeys.map(k => `${k}=${JSON.stringify(first[k])?.slice(0,40)}`).join(' | ')
          console.log(`   first: ${keys}`)
        } else {
          console.log(`   first keys: ${Object.keys(first ?? {}).slice(0, 8).join(', ')}`)
        }
      }
    } else {
      const keys = sampleKeys.length > 0
        ? sampleKeys.map(k => `${k}=${JSON.stringify(data[k])?.slice(0,40)}`).join(' | ')
        : Object.keys(data).slice(0, 8).join(', ')
      console.log(`   keys: ${keys}`)
    }
  }
  console.log()
}

// ── 3. Test 1: GET /seller-promotions/users/:id ─────────────────────
console.log('━━━ TEST 1: GET /seller-promotions/users/:id (listar campanhas)')
const r1 = await ml('GET', `/seller-promotions/users/${SELLER_ID}`, { app_version: 'v2' })
logResult('seller-promotions/users', r1, ['id', 'name', 'type', 'status', 'finish_date', 'benefits'])

// Salva primeira campanha pra usar nos próximos testes
let firstCampaign = null
if (r1.ok) {
  const campaigns = Array.isArray(r1.body) ? r1.body : (r1.body.results ?? [])
  firstCampaign = campaigns[0]
  if (firstCampaign) {
    console.log(`   → usando campaign_id=${firstCampaign.id} type=${firstCampaign.type ?? firstCampaign.promotion_type} pros próximos testes\n`)
  }
}

// ── 4. Test 2: GET /seller-promotions/promotions/:id/items ──────────
if (firstCampaign) {
  console.log('━━━ TEST 2: GET /seller-promotions/promotions/:id/items (paginação search_after)')
  const promotionType = firstCampaign.type ?? firstCampaign.promotion_type ?? 'DEAL'
  const r2 = await ml('GET', `/seller-promotions/promotions/${firstCampaign.id}/items`, {
    promotion_type: promotionType,
    app_version: 'v2',
    limit: 5,
  })
  logResult(`promotions/${firstCampaign.id}/items?type=${promotionType}`, r2, ['id', 'status', 'price', 'original_price', 'min_price', 'max_price'])

  // Salva primeiro item
  if (r2.ok) {
    const items = r2.body.results ?? []
    if (items[0]) {
      console.log(`   → primeiro item: ${items[0].id}\n`)
    }
  }

  // Test 2b: paginação search_after
  if (r2.ok && r2.body.paging?.search_after) {
    console.log('━━━ TEST 2b: paginação search_after')
    const r2b = await ml('GET', `/seller-promotions/promotions/${firstCampaign.id}/items`, {
      promotion_type: promotionType,
      app_version: 'v2',
      limit: 5,
      search_after: r2.body.paging.search_after,
    })
    logResult('paginação search_after (página 2)', r2b)
  } else {
    console.log('   (sem paginação — só 1 página)\n')
  }
} else {
  console.log('━━━ TEST 2: PULADO (sem campanha disponível)\n')
}

// ── 5. Test 3: GET /seller-promotions/items/:itemId ─────────────────
// Pega primeiro item ativo da Vazzo pra testar
console.log('━━━ TEST 3: GET /seller-promotions/items/:itemId (promoções de 1 item)')
const itemsRes = await ml('GET', `/users/${SELLER_ID}/items/search`, { limit: 1, status: 'active' })
const sampleItemId = itemsRes.body?.results?.[0]
if (sampleItemId) {
  console.log(`   → testando com item: ${sampleItemId}`)
  const r3 = await ml('GET', `/seller-promotions/items/${sampleItemId}`, { app_version: 'v2' })
  logResult(`seller-promotions/items/${sampleItemId}`, r3, ['id', 'type', 'status', 'offer_id'])
} else {
  console.log('   (não foi possível pegar item da Vazzo)\n')
}

// ── 6. Test 4: GET /sites/MLB/listing_prices ────────────────────────
console.log('━━━ TEST 4: GET /sites/MLB/listing_prices (custos ML pra cálculo de margem)')
const r4 = await ml('GET', '/sites/MLB/listing_prices', {
  category_id: 'MLB8462', // Lâmpadas (tem item da Vazzo)
  listing_type_id: 'gold_special',
  price: 100,
})
logResult('listing_prices?category=MLB8462', r4, ['listing_type_id', 'sale_fee_amount', 'sale_fee_details', 'free_shipping_cost'])

// ── 7. Resumo ────────────────────────────────────────────────────────
console.log('━━━ POST/PUT/DELETE /seller-promotions/offers')
console.log('   ⏭  PULADOS — exigem oferta real numa campanha de teste.')
console.log('       Validar manualmente quando houver candidato disponível.')
console.log('       Payload esperado:')
console.log('       POST /seller-promotions/offers')
console.log('       {')
console.log('         promotion_id: "...", promotion_type: "DEAL",')
console.log('         item_id: "MLB...", offer_price: 79.90, offer_quantity: 30')
console.log('       }\n')

console.log('🏁 Smoke test finalizado.')
