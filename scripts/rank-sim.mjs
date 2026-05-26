#!/usr/bin/env node
/**
 * Roda o GEO Rank Simulator (POST /ai-visibility/optimize/simulate) num produto
 * e imprime a posição antes×depois. NÃO publica nada. Uso:
 *   node scripts/rank-sim.mjs "<url>"
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
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function mintJwt() {
  const g = await fetch(`${SUPA}/auth/v1/admin/generate_link`, {
    method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email: EMAIL }),
  })
  const gj = await g.json()
  const hashed = gj?.properties?.hashed_token || gj?.hashed_token
  if (!hashed) throw new Error('generate_link falhou')
  const v = await fetch(`${SUPA}/auth/v1/verify`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed }),
  })
  const vj = await v.json(); if (!vj.access_token) throw new Error('verify falhou')
  return vj.access_token
}

async function main() {
  if (!URL_ARG) { console.error('uso: node scripts/rank-sim.mjs "<url>"'); process.exit(1) }
  const jwt = await mintJwt()
  let j, status
  for (let i = 1; i <= 16; i++) {
    const res = await fetch(`${BACKEND}/ai-visibility/optimize/simulate`, {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: URL_ARG }),
    })
    status = res.status
    const txt = await res.text(); try { j = JSON.parse(txt) } catch { j = { raw: txt } }
    if (status === 404) { console.log(`  aguardando deploy… ${i} (404)`); await sleep(12000); continue }
    break
  }
  if (status !== 200 && status !== 201) { console.error(`FALHOU ${status}: ${JSON.stringify(j).slice(0, 300)}`); process.exit(1) }
  console.log(`\n=== GEO Rank Simulator — ${j.title} ===`)
  console.log(`Categoria: ${j.category} | candidatos no páreo: ${j.candidate_count} | nota: ${j.note ?? 'ok'}`)
  if (j.note && j.note !== 'ok') { console.log('(sem ranking — ver note acima)'); return }
  console.log(`\nPosição média:  ANTES ${j.avg_rank_before}  →  DEPOIS ${j.avg_rank_after}   (delta ${j.rank_delta > 0 ? '+' : ''}${j.rank_delta} = ${j.rank_delta > 0 ? 'SUBIU ✅' : j.rank_delta < 0 ? 'caiu' : 'igual'})`)
  console.log(`Descrição otimizada usada: ${j.optimized ? 'sim' : 'não (fallback)'}\n`)
  console.log('Por query (posição antes → depois):')
  for (const q of (j.queries || [])) console.log(`  • "${q.query}"\n      ${q.rank_before ?? '—'} → ${q.rank_after ?? '—'}`)
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1) })
