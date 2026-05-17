#!/usr/bin/env node
/**
 * Roda SELECT via _admin_query_sql RPC e retorna rows como JSON.
 *
 * Uso:
 *   node scripts/query.mjs "SELECT * FROM products LIMIT 1"
 *   echo "SELECT ..." | node scripts/query.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

const here = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.resolve(here, '..', '.env')
config({ path: envPath })

const SUPA_URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPA_URL || !KEY) {
  console.error('[query] FATAL: SUPABASE_URL ou SUPABASE_SECRET_KEY/SERVICE_ROLE_KEY não setados em .env')
  process.exit(1)
}

let sql = process.argv[2]
if (!sql) {
  if (!process.stdin.isTTY) {
    sql = fs.readFileSync(0, 'utf8').trim()
  }
}
if (!sql) {
  console.error('[query] Uso: node scripts/query.mjs "<SELECT ...>"  (ou pipe via stdin)')
  process.exit(1)
}

const url = `${SUPA_URL.replace(/\/+$/, '')}/rest/v1/rpc/_admin_query_sql`
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'apikey':        KEY,
    'Authorization': `Bearer ${KEY}`,
    'Content-Type':  'application/json',
  },
  body: JSON.stringify({ sql }),
})

const body = await res.json().catch(() => null)

if (!res.ok) {
  console.error(`[query] HTTP ${res.status}:`)
  console.error(JSON.stringify(body, null, 2))
  process.exit(1)
}

if (body && typeof body === 'object' && !Array.isArray(body) && body.error) {
  console.error(`[query] SQL error (state ${body.state}): ${body.error}`)
  process.exit(1)
}

console.log(JSON.stringify(body, null, 2))
