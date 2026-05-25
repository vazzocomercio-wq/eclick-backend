#!/usr/bin/env node
/**
 * Aplica (PUBLICA no ML) os 4 rascunhos JÁ gerados do piloto, por optimizer_id,
 * reusando os drafts do `pilot-apply.mjs draft` (sem custo de LLM extra).
 * Título travado (sold>0) → só descrição publica. confirm_batch_expansion=true
 * porque o cap diário (5) já foi consumido por 1 piloto real + 2 testes (bambu).
 *
 * Uso: node scripts/pilot-apply-ids.mjs
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

const DRAFTS = [
  { sku: 'CD251228',      mlb: 'MLB6501371484', optId: 'e2b817a2-806b-468f-b5c4-f256e47a2574' },
  { sku: 'CD202130/1D',   mlb: 'MLB4028447447', optId: '4dca5212-06a0-4a1f-8cd3-ef35f0496635' },
  { sku: 'CD2024073144D', mlb: 'MLB6291269794', optId: 'd16aba30-5b91-4bad-9c46-d7102f9e0064' },
  { sku: '2022056G',      mlb: 'MLB5918499510', optId: '677bee0c-50f3-428f-ba0c-19c6319c49b5' },
]

async function mintJwt() {
  const g = await fetch(`${SUPA}/auth/v1/admin/generate_link`, {
    method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email: EMAIL }),
  })
  const gj = await g.json()
  const hashed = gj?.properties?.hashed_token || gj?.hashed_token
  if (!hashed) throw new Error(`generate_link falhou: ${JSON.stringify(gj).slice(0, 300)}`)
  const v = await fetch(`${SUPA}/auth/v1/verify`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed }),
  })
  const vj = await v.json()
  if (!vj.access_token) throw new Error(`verify falhou: ${JSON.stringify(vj).slice(0, 300)}`)
  return vj.access_token
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const jwt = await mintJwt()
  console.log(`JWT ok. Aplicando ${DRAFTS.length} rascunhos (description-only)...\n`)
  const results = []
  for (const d of DRAFTS) {
    const res = await fetch(`${BACKEND}/ai-visibility/optimize/${d.optId}/apply?confirm_batch_expansion=true`, {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ variant: 'A' }),
    })
    const txt = await res.text(); let j; try { j = JSON.parse(txt) } catch { j = { raw: txt } }
    if (res.status === 200 || res.status === 201) {
      console.log(`  ✅ ${d.sku} ${d.mlb} — version=${j.versionId} títuloTravado=${j.titleLocked} títuloAplicado=${j.titleApplied}`)
      results.push({ ...d, ok: true, versionId: j.versionId })
    } else {
      console.log(`  ❌ ${d.sku} ${d.mlb} — ${res.status}: ${JSON.stringify(j).slice(0, 240)}`)
      results.push({ ...d, ok: false, status: res.status })
    }
    await sleep(1500)
  }
  const ok = results.filter(r => r.ok).length
  console.log(`\n${ok}/${DRAFTS.length} aplicados.`)
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1) })
