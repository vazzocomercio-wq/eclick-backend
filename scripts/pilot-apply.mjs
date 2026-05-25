#!/usr/bin/env node
/**
 * Piloto GEO Optimizer (Dia 12) — aplica descrição otimizada (description-only)
 * nos 4 anúncios LIMPOS escolhidos, fechando o piloto em 5 (com a Torneira).
 *
 * Faz a coisa toda pelo backend de PRODUÇÃO (código deployado a405621), com JWT
 * real do dono da org (minted via GoTrue admin), pra passar pelo SupabaseAuthGuard
 * e disparar telemetria + salvaguardas (cap diário, versão, baseline) de verdade.
 *
 * Título dos 4 está TRAVADO (sold_quantity>0) → só a descrição publica. O
 * publisher é resiliente: descrição obrigatória, título best-effort.
 *
 * Uso:
 *   node scripts/pilot-apply.mjs draft   # só gera rascunhos (NÃO publica)
 *   node scripts/pilot-apply.mjs apply   # gera rascunho + PUBLICA no ML
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
const MODE = (process.argv[2] || 'draft').toLowerCase()

const LISTINGS = [
  { sku: 'CD251228',      mlb: 'MLB6501371484', url: 'https://produto.mercadolivre.com.br/MLB-6501371484-abajur-tnt-minecraft-luminaria-usb-recarregavel-som-vazzo-vermelho-127220v-_JM' },
  { sku: 'CD202130/1D',   mlb: 'MLB4028447447', url: 'https://produto.mercadolivre.com.br/MLB-4028447447-lustre-pendente-cristal-dourado-7w-bivolt-3000k-bivolt-127220v-dourado-_JM' },
  { sku: 'CD2024073144D', mlb: 'MLB6291269794', url: 'https://produto.mercadolivre.com.br/MLB-6291269794-arandela-parede-cristal-legitimo-k9-vazzo-quarto-sala-127220v-prateado-_JM' },
  { sku: '2022056G',      mlb: 'MLB5918499510', url: 'https://produto.mercadolivre.com.br/MLB-5918499510-torneira-cozinha-parede-gourmet-monocomando-inoxidavel-vazzo-dourado-brilhante-_JM' },
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

async function api(jwt, method, pathname, body) {
  const res = await fetch(`${BACKEND}${pathname}`, {
    method, headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const txt = await res.text()
  let json; try { json = JSON.parse(txt) } catch { json = { raw: txt } }
  return { status: res.status, json }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log(`\n=== Piloto GEO Optimizer — MODE=${MODE} ===`)
  if (!['draft', 'apply'].includes(MODE)) { console.error('MODE inválido: use draft | apply'); process.exit(1) }
  const jwt = await mintJwt()
  console.log(`JWT ok (len ${jwt.length}). Backend: ${BACKEND}\n`)

  const results = []
  for (const L of LISTINGS) {
    console.log(`\n── ${L.sku} (${L.mlb}) ──`)
    // 1) Rascunho (não publica).
    const o = await api(jwt, 'POST', '/ai-visibility/optimize', { url: L.url })
    if (o.status !== 201 && o.status !== 200) {
      console.log(`  optimize FALHOU (${o.status}): ${JSON.stringify(o.json).slice(0, 220)}`)
      results.push({ ...L, ok: false, step: 'optimize', status: o.status })
      continue
    }
    const optId = o.json.optimizerId
    const dOld = (o.json.description_old || '').length
    const dNew = (o.json.description_new || '').length
    console.log(`  rascunho ${optId} | descrição ${dOld} → ${dNew} chars | custo $${o.json.cost_usd}`)
    console.log(`  prévia nova: ${String(o.json.description_new || '').replace(/\s+/g, ' ').slice(0, 180)}…`)

    if (MODE === 'draft') { results.push({ ...L, ok: true, step: 'draft', optId, dOld, dNew }); continue }

    // 2) Aplica (publica descrição no ML). Título travado (sold>0) → best-effort.
    await sleep(800)
    const a = await api(jwt, 'POST', `/ai-visibility/optimize/${optId}/apply?confirm_batch_expansion=true`, { variant: 'A' })
    if (a.status !== 201 && a.status !== 200) {
      console.log(`  APPLY FALHOU (${a.status}): ${JSON.stringify(a.json).slice(0, 260)}`)
      results.push({ ...L, ok: false, step: 'apply', status: a.status, optId })
      continue
    }
    console.log(`  ✅ APLICADO | version=${a.json.versionId} | títuloAplicado=${a.json.titleApplied} | títuloTravado=${a.json.titleLocked}`)
    results.push({ ...L, ok: true, step: 'apply', optId, versionId: a.json.versionId, titleLocked: a.json.titleLocked })
    await sleep(1200)
  }

  console.log(`\n=== Resumo (${MODE}) ===`)
  for (const r of results) {
    console.log(`  ${r.ok ? 'OK ' : 'FALHA'} ${r.sku} ${r.mlb} — ${r.step}${r.versionId ? ' v=' + r.versionId : ''}${r.status ? ' status=' + r.status : ''}`)
  }
  const ok = results.filter(r => r.ok && r.step === MODE).length
  console.log(`\n${ok}/${LISTINGS.length} ${MODE === 'apply' ? 'aplicados' : 'rascunhos gerados'}.`)
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1) })
