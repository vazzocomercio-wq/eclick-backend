#!/usr/bin/env node
/**
 * Gera um RASCUNHO de otimização (POST /ai-visibility/optimize) e imprime
 * títulos + descrição. NÃO publica nada. Pra validar os prompts do Optimizer.
 *
 * Uso: node scripts/optimize-draft.mjs "<url>"
 */
import { config } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
const BACKEND = 'https://eclick-backend-production-2a87.up.railway.app'
const EMAIL = 'vazzocomercio@gmail.com'
const URL_ARG = process.argv[2]

async function mintJwt() {
  const g = await fetch(`${SUPA}/auth/v1/admin/generate_link`, {
    method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email: EMAIL }),
  })
  const gj = await g.json(); const hashed = gj?.properties?.hashed_token || gj?.hashed_token
  if (!hashed) throw new Error('generate_link falhou')
  const v = await fetch(`${SUPA}/auth/v1/verify`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed }),
  })
  const vj = await v.json(); if (!vj.access_token) throw new Error('verify falhou')
  return vj.access_token
}

async function main() {
  if (!URL_ARG) { console.error('uso: node scripts/optimize-draft.mjs "<url>"'); process.exit(1) }
  const jwt = await mintJwt()
  const res = await fetch(`${BACKEND}/ai-visibility/optimize`, {
    method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: URL_ARG }),
  })
  const txt = await res.text(); let j; try { j = JSON.parse(txt) } catch { j = { raw: txt } }
  if (res.status !== 200 && res.status !== 201) { console.error(`FALHOU ${res.status}: ${JSON.stringify(j).slice(0, 300)}`); process.exit(1) }
  console.log(`\n=== RASCUNHO (${URL_ARG}) — custo $${j.cost_usd} ===\n`)
  console.log('TÍTULOS:')
  for (const v of (j.title_variations || [])) console.log(`  [${v.variant}/${v.type}] (${(v.title||'').length}c) ${v.title}\n     query-alvo: ${v.target_query}`)
  console.log(`\nDESCRIÇÃO ANTES (${(j.description_old||'').length}c) → DEPOIS (${(j.description_new||'').length}c)\n`)
  console.log('--- DESCRIÇÃO NOVA ---')
  console.log(j.description_new || '(vazia)')
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1) })
