#!/usr/bin/env node
/**
 * Apply a SQL migration via the `_admin_exec_sql` RPC (service_role only).
 *
 * Setup uma vez: cole `supabase/migrations/00000000_admin_exec_sql_rpc.sql`
 * no SQL Editor do Supabase Studio. Depois disso, este script aplica
 * qualquer migration sem precisar do Studio.
 *
 * Uso:
 *   node scripts/apply-migration.mjs supabase/migrations/20260507_creative_image_pipeline.sql
 *
 * Limitações conhecidas (herdadas do RPC):
 *   - Não pode mexer em storage.objects policies (use Studio)
 *   - Não pode rodar comandos que precisam de superuser (CREATE EXTENSION
 *     com privilégios elevados, etc.)
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

// Carrega .env do diretório do backend (fileURLToPath lida com Windows + espaços corretamente)
const here = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.resolve(here, '..', '.env')
config({ path: envPath })

const SUPA_URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPA_URL || !KEY) {
  console.error('[apply-migration] FATAL: SUPABASE_URL ou SUPABASE_SECRET_KEY/SERVICE_ROLE_KEY não setados em .env')
  process.exit(1)
}

const file = process.argv[2]
if (!file) {
  console.error('[apply-migration] Uso: node scripts/apply-migration.mjs <path-to-sql>')
  process.exit(1)
}

const absPath = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file)
if (!fs.existsSync(absPath)) {
  console.error(`[apply-migration] arquivo não encontrado: ${absPath}`)
  process.exit(1)
}

const sql = fs.readFileSync(absPath, 'utf8')

console.log(`[apply-migration] aplicando ${path.basename(absPath)} (${sql.length} chars)…`)

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

const text = await res.text()
let body
try { body = JSON.parse(text) } catch { body = text }

if (!res.ok) {
  console.error(`[apply-migration] HTTP ${res.status}:`)
  console.error(body)

  // Erro tipico se o RPC ainda não foi criado
  if (res.status === 404 || (typeof body === 'object' && body?.message?.includes?.('_admin_exec_sql'))) {
    console.error('')
    console.error('  ⚠️  O RPC _admin_exec_sql não existe no banco.')
    console.error('  Cole supabase/migrations/00000000_admin_exec_sql_rpc.sql no SQL Editor do Studio')
    console.error('  e tente novamente.')
  }
  process.exit(1)
}

if (typeof body === 'object' && body?.ok === false) {
  console.error('[apply-migration] FALHOU:')
  console.error(`  state: ${body.state}`)
  console.error(`  error: ${body.error}`)
  process.exit(1)
}

console.log('[apply-migration] ✓ aplicado com sucesso')
