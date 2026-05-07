#!/usr/bin/env node
/** Investiga shape detalhado das campanhas e lista todas as 5. */

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
const SELLER_ID = conn.seller_id

async function ml(path, params = null) {
  const url = new URL(`${ML_BASE}${path}`)
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })
  return { status: res.status, body: await res.json() }
}

console.log('\n📋 LISTAR TODAS as 5 campanhas COM detalhes:\n')

const r = await ml(`/seller-promotions/users/${SELLER_ID}`, { app_version: 'v2' })
const campaigns = r.body.results ?? r.body

for (const c of campaigns) {
  console.log(`──── ${c.id} (${c.type ?? c.promotion_type})`)
  console.log(JSON.stringify(c, null, 2))
  console.log()
}

console.log('\n📋 Tentando SEM app_version=v2 (talvez retorne shape mais rico):\n')
const r2 = await ml(`/seller-promotions/users/${SELLER_ID}`)
console.log('first:', JSON.stringify((r2.body.results ?? r2.body)[0], null, 2))

console.log('\n📋 Tentando GET individual em LGH-MLB1000:')
const r3 = await ml(`/seller-promotions/promotions/LGH-MLB1000`, { app_version: 'v2' })
console.log(JSON.stringify(r3, null, 2))

console.log('\n📋 Detalhe de items com filtros de status:\n')
for (const status of ['candidate', 'pending', 'started']) {
  const r = await ml(`/seller-promotions/promotions/LGH-MLB1000/items`, {
    promotion_type: 'LIGHTNING',
    app_version: 'v2',
    status,
    limit: 1,
  })
  console.log(`status=${status}: ${r.status === 200 ? `${r.body.results?.length ?? 0} items / total=${r.body.paging?.total}` : 'erro'}`)
  if (r.body.results?.[0]) {
    console.log('  shape:', JSON.stringify(r.body.results[0], null, 2).slice(0, 500))
  }
  console.log()
}
