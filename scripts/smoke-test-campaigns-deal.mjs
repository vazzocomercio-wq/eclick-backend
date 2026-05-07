#!/usr/bin/env node
/** Investiga DEAL "05.05 e Dia das Maes" pra ver shape de itens e benefits. */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA_URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
const ML_BASE = 'https://api.mercadolibre.com'

async function getToken() {
  const url = `${SUPA_URL.replace(/\/+$/, '')}/rest/v1/rpc/_admin_query_sql`
  const res = await fetch(url, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: `SELECT seller_id, access_token FROM ml_connections WHERE nickname='VAZZO_' LIMIT 1` }),
  })
  return (await res.json())[0]
}

const conn = await getToken()
const TOKEN = conn.access_token

async function ml(path, params = null) {
  const url = new URL(`${ML_BASE}${path}`)
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })
  return { status: res.status, body: await res.json() }
}

const CAMPAIGN_ID = 'P-MLB17383010' // DEAL "05.05 e Dia das Maes"
const TYPE = 'DEAL'

console.log('\n📋 ITEMS da DEAL "05.05 e Dia das Maes":\n')

for (const status of ['candidate', 'pending', 'started']) {
  const r = await ml(`/seller-promotions/promotions/${CAMPAIGN_ID}/items`, {
    promotion_type: TYPE,
    app_version: 'v2',
    status,
    limit: 2,
  })
  console.log(`status=${status}: total=${r.body.paging?.total ?? 0}`)
  if (r.body.results?.[0]) {
    console.log('  primeiro item shape:')
    console.log(JSON.stringify(r.body.results[0], null, 2))
  }
  console.log()
}

console.log('\n📋 Investigar /seller-promotions/items/MLB... pra item Vazzo (todas promoções desse item):\n')
const itemsRes = await ml(`/users/${conn.seller_id}/items/search`, { limit: 3, status: 'active' })
const items = itemsRes.body?.results ?? []
for (const itemId of items.slice(0, 1)) {
  const r = await ml(`/seller-promotions/items/${itemId}`, { app_version: 'v2' })
  console.log(`Item ${itemId}: ${r.body.length ?? 0} promoções elegíveis`)
  if (r.body[0]) {
    console.log('  primeira:')
    console.log(JSON.stringify(r.body[0], null, 2))
  }
  console.log()
}

console.log('\n📋 Tentar get candidate específico (vinha por webhook na spec):\n')
const candidateId = 'CANDIDATE-MLB6513077532-75874265738'
const r3 = await ml(`/seller-promotions/candidates/${candidateId}`, { app_version: 'v2' })
console.log(`/seller-promotions/candidates/${candidateId}: status=${r3.status}`)
console.log(JSON.stringify(r3.body, null, 2))

console.log('\n📋 Listar com status=candidate (só candidatos disponíveis):\n')
const r4 = await ml(`/seller-promotions/promotions/${CAMPAIGN_ID}/items`, {
  promotion_type: TYPE,
  app_version: 'v2',
  status: 'candidate',
  limit: 50,
})
console.log(`Total candidates: ${r4.body.paging?.total}`)
if (r4.body.results) {
  console.log(`Primeiros 3:`)
  for (const it of r4.body.results.slice(0, 3)) {
    console.log(`  ${it.id} — price=${it.price} (orig ${it.original_price}) min=${it.min_discounted_price} stock=${JSON.stringify(it.stock)}`)
  }
}
