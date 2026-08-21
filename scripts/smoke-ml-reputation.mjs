#!/usr/bin/env node
/**
 * Smoke test do módulo de reputação ML (antes/depois da migration 20260650).
 *
 * Uso: node scripts/smoke-ml-reputation.mjs [--expect-missing]
 *   --expect-missing  → antes da migration: confirma que as tabelas NÃO existem
 *   (sem a flag)      → depois: tabelas existem, 2 regras embutidas, RPC responde
 *
 * Lê SUPABASE_URL + SUPABASE_SECRET_KEY do .env (mesmo padrão do apply-migration).
 * Não altera nada no banco.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SECRET_KEY ausentes no .env'); process.exit(1) }
const expectMissing = process.argv.includes('--expect-missing')
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

async function rest(pathname, init) {
  const res = await fetch(`${URL.replace(/\/+$/, '')}/rest/v1/${pathname}`, { headers: H, ...init })
  const text = await res.text()
  let body; try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

const TABLES = ['ml_reputation_rule_sets', 'ml_reputation_current', 'ml_reputation_snapshots', 'ml_reputation_events']
let failures = 0
const ok = (label, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`); if (!cond) failures++ }

for (const t of TABLES) {
  const r = await rest(`${t}?select=*&limit=1`)
  if (expectMissing) ok(`${t} ainda não existe`, r.status === 404 || r.status === 400, `HTTP ${r.status}`)
  else ok(`${t} existe e responde`, r.status === 200, `HTTP ${r.status}`)
}

if (!expectMissing) {
  const rules = await rest('ml_reputation_rule_sets?select=name,effective_from,effective_until,is_builtin&order=effective_from.asc.nullsfirst')
  const names = Array.isArray(rules.body) ? rules.body.map(r => r.name) : []
  ok('regras embutidas presentes', names.includes('ML_REPUTATION_LEGACY') && names.includes('ML_REPUTATION_2026_09'), names.join(', '))

  // RPC com org/seller inexistentes → deve responder JSON com zeros (não erro)
  const rpc = await rest('rpc/ml_reputation_account_counts', {
    method: 'POST',
    body: JSON.stringify({ p_org: '00000000-0000-0000-0000-000000000000', p_seller: 1, p_now: new Date().toISOString(), p_short_days: 60, p_long_days: 365 }),
  })
  const shape = rpc.body && typeof rpc.body === 'object' && rpc.body.short && rpc.body.long
  ok('RPC ml_reputation_account_counts responde', rpc.status === 200 && !!shape, `HTTP ${rpc.status} ${shape ? `short.counted=${rpc.body.short.counted}` : JSON.stringify(rpc.body).slice(0, 120)}`)

  // Tabelas pré-existentes continuam íntegras
  for (const t of ['orders', 'ml_claims', 'ml_shipment_delays', 'ml_seller_reputation_current', 'ml_connections']) {
    const r = await rest(`${t}?select=*&limit=1`)
    ok(`${t} continua acessível`, r.status === 200, `HTTP ${r.status}`)
  }
}

console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FALHOU (${failures})`)
process.exit(failures === 0 ? 0 : 1)
