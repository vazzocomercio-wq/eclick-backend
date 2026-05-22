#!/usr/bin/env node
/**
 * Roda DML/DDL via _admin_exec_sql RPC (write-capable).
 *
 * Uso:
 *   node scripts/exec.mjs "UPDATE foo SET bar = 1 WHERE id = '...'"
 *   echo "UPDATE ..." | node scripts/exec.mjs
 *
 * ⚠️ Diferente de query.mjs (que é SELECT-only via _admin_query_sql).
 *    Use com cuidado — isso executa escrita em prod.
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
  console.error('[exec] FATAL: SUPABASE_URL ou SUPABASE_SECRET_KEY/SERVICE_ROLE_KEY não setados em .env')
  process.exit(1)
}

let sql = process.argv[2]
if (!sql && !process.stdin.isTTY) sql = fs.readFileSync(0, 'utf8').trim()
if (!sql) {
  console.error('[exec] Uso: node scripts/exec.mjs "<SQL>"  (ou pipe via stdin)')
  process.exit(1)
}

const url = `${SUPA_URL.replace(/\/+$/, '')}/rest/v1/rpc/_admin_exec_sql`
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
  console.error(`[exec] HTTP ${res.status}:`)
  console.error(JSON.stringify(body, null, 2))
  process.exit(1)
}

if (body && typeof body === 'object' && !Array.isArray(body) && body.error) {
  console.error(`[exec] SQL error (state ${body.state}): ${body.error}`)
  process.exit(1)
}

console.log('[exec] OK')
console.log(JSON.stringify(body, null, 2))
