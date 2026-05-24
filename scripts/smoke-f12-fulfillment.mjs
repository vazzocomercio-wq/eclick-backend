#!/usr/bin/env node
/**
 * Smoke test — F12 Fulfillment Sprint 0.
 *
 * Prova o fluxo ponta-a-ponta contra um backend LOCAL (npm run start:dev):
 *   CD → seed pedido B2B → bipa errado (BLOQUEIA + loga mismatch) → bipa certo
 *   → conclui separação → bipa o pedido → (foto) → fecha conferência →
 *   imprime etiqueta (ZPL) → confirma status 'shipped'. No fim, LIMPA os
 *   dados de teste (cascade no fulfillment_order).
 *
 * Por que .mjs e não Cypress: o coração do PWA é hardware (leitor BT que
 * digita como teclado + câmera getUserMedia) — Cypress não simula de forma
 * confiável. Este smoke é determinístico e segue o padrão da casa (smoke-f11).
 *
 * Uso (com o backend rodando local em :3001):
 *   node scripts/smoke-f12-fulfillment.mjs
 *   SMOKE_BACKEND=http://localhost:3001 node scripts/smoke-f12-fulfillment.mjs
 *
 * Pre-req env (.env): SUPABASE_URL, service key, anon/publishable key.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA_URL = process.env.SUPABASE_URL
const SVC_KEY  = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY
const BACKEND  = process.env.SMOKE_BACKEND ?? process.argv[2] ?? 'http://localhost:3001'
const EMAIL    = process.env.SMOKE_EMAIL ?? 'vazzocomercio@gmail.com'
const ORG      = process.env.SMOKE_ORG ?? '4ef1aabd-c209-40b0-b034-ef69dcb66833' // Vazzo

if (!SUPA_URL || !SVC_KEY || !ANON_KEY) {
  console.error('[smoke-f12] FATAL: SUPABASE_URL + service key + anon/publishable key são obrigatórios no .env')
  process.exit(1)
}

// Imagem de teste (~2KB) — só precisa passar na validação de tamanho do
// upload (a conferência por IA vem desligada por padrão, então não precisa
// ser uma imagem decodificável de verdade).
const TEST_IMG = Buffer.alloc(2048, 7).toString('base64')

let pass = 0, fail = 0
const ok  = (m) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`) }
const bad = (m) => { fail++; console.log(`  \x1b[31m✗ ${m}\x1b[0m`) }
function assert(cond, m) { cond ? ok(m) : bad(m) }

async function mintJwt() {
  const admin = createClient(SUPA_URL, SVC_KEY,  { auth: { persistSession: false } })
  const anon  = createClient(SUPA_URL, ANON_KEY, { auth: { persistSession: false } })
  const { data: link, error: le } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL })
  if (le || !link?.properties?.hashed_token) throw new Error(`generateLink: ${le?.message ?? 'sem hashed_token'}`)
  const { data: s, error: ve } = await anon.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (ve || !s?.session?.access_token) throw new Error(`verifyOtp: ${ve?.message ?? 'sem token'}`)
  return s.session.access_token
}

async function call(token, method, pathname, body, expectStatus) {
  const res = await fetch(`${BACKEND}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = text }
  if (expectStatus && res.status !== expectStatus) {
    throw new Error(`${method} ${pathname} → ${res.status} (esperava ${expectStatus}): ${typeof json === 'string' ? json : JSON.stringify(json)}`)
  }
  return { status: res.status, json }
}

async function main() {
  console.log(`\n\x1b[1mF12 Fulfillment — smoke\x1b[0m  (backend: ${BACKEND})\n`)

  // ── Health check do backend ──────────────────────────────────────────
  try {
    const h = await fetch(`${BACKEND}/health`)
    if (!h.ok) throw new Error(String(h.status))
  } catch (e) {
    console.error(`\x1b[31m[smoke-f12] backend não respondeu em ${BACKEND}/health — suba o backend local (npm run start:dev) antes.\x1b[0m`)
    process.exit(1)
  }

  const token = await mintJwt()
  ok('JWT da Vazzo emitido')

  // ── 1. CD (warehouse) ──────────────────────────────────────────────────
  let warehouseId
  const whs = await call(token, 'GET', '/fulfillment/warehouses')
  const existing = (whs.json ?? []).find((w) => w.code === 'SMOKE-CD')
  if (existing) {
    warehouseId = existing.id
    ok('CD de teste reaproveitado (SMOKE-CD)')
  } else {
    const created = await call(token, 'POST', '/fulfillment/warehouses', { name: 'CD Smoke', code: 'SMOKE-CD' }, 201)
    warehouseId = created.json.id
    ok('CD de teste criado (SMOKE-CD)')
  }

  // ── 2. Seed pedido B2B (2 itens com barcode conhecido) ──────────────────
  const seedBody = {
    source: 'b2b',
    warehouseId,
    channel: 'b2b',
    customer: { name: 'Revenda Smoke F12' },
    items: [
      { sku: 'SMOKE-SKU-A', title: 'Produto A', qty: 2, barcode: '7890000000017' },
      { sku: 'SMOKE-SKU-B', title: 'Produto B', qty: 1, barcode: '7890000000024' },
    ],
  }
  const seeded = await call(token, 'POST', '/fulfillment/pick-tasks/seed', seedBody, 201)
  const foId = seeded.json.fulfillmentOrderId
  assert(!!foId && seeded.json.pickTasks === 2, `Seed criou pedido + 2 pick_tasks (fo=${foId?.slice(0, 8)})`)

  // ── 3. Fila de separação ────────────────────────────────────────────────
  const queue = await call(token, 'GET', `/fulfillment/pick-tasks/queue?warehouse_id=${warehouseId}`)
  const myTasks = (queue.json ?? []).filter((t) => t.fulfillment_order_id === foId)
  assert(myTasks.length === 2, 'Fila trouxe os 2 itens do pedido')
  const taskA = myTasks.find((t) => t.sku === 'SMOKE-SKU-A')
  const taskB = myTasks.find((t) => t.sku === 'SMOKE-SKU-B')

  // ── 4. CRÍTICO: bipar código ERRADO → 400 (bloqueado) ───────────────────
  const wrong = await call(token, 'POST', `/fulfillment/pick-tasks/${taskA.id}/scan-item`, { code: 'CODIGO-ERRADO-999' })
  assert(wrong.status === 400, 'Bipagem de código ERRADO foi BLOQUEADA (400)')

  // ── 5. Bipar certo: SKU (A, 2x) + EAN (B, 1x) ───────────────────────────
  const a1 = await call(token, 'POST', `/fulfillment/pick-tasks/${taskA.id}/scan-item`, { code: 'SMOKE-SKU-A' }, 201)
  assert(a1.json.matched && a1.json.picked_qty === 1, 'Item A bipado por SKU (1/2)')
  const a2 = await call(token, 'POST', `/fulfillment/pick-tasks/${taskA.id}/scan-item`, { code: 'smoke-sku-a' }, 201)
  assert(a2.json.status === 'picked' && a2.json.picked_qty === 2, 'Item A completo (2/2, case-insensitive)')
  const b1 = await call(token, 'POST', `/fulfillment/pick-tasks/${taskB.id}/scan-item`, { code: '7890000000024' }, 201)
  assert(b1.json.status === 'picked', 'Item B bipado por EAN → separado')

  // ── 6. Pack auto-promovido (trigger) ────────────────────────────────────
  const packQ = await call(token, 'GET', `/fulfillment/pack-tasks/queue?warehouse_id=${warehouseId}`)
  const packTask = (packQ.json ?? []).find((p) => p.fulfillment_order_id === foId)
  assert(!!packTask, 'Pack task promovido p/ ready_to_pack (trigger pick→pack)')

  // ── 7. Bipar o pedido (libera conferência) ──────────────────────────────
  await call(token, 'POST', `/fulfillment/pack-tasks/${packTask.id}/scan-order`, { code: foId }, 201)
  ok('Pedido bipado (conferência liberada)')

  // ── 8. Foto do pacote (opcional) ────────────────────────────────────────
  const photo = await call(token, 'POST', `/fulfillment/pack-tasks/${packTask.id}/photo`, { imageBase64: TEST_IMG, mimeType: 'image/jpeg' }, 201)
  assert(photo.json.ok, 'Foto do pacote enviada')

  // ── 9. Fechar conferência ───────────────────────────────────────────────
  const done = await call(token, 'POST', `/fulfillment/pack-tasks/${packTask.id}/complete`, undefined, 201)
  assert(done.json.ok, 'Conferência fechada (packed)')

  // ── 10. Etiqueta (B2B → ZPL fallback) ───────────────────────────────────
  const label = await call(token, 'POST', '/fulfillment/shipment-labels/print', { fulfillmentOrderId: foId }, 201)
  assert(label.json.ok && label.json.format === 'ZPL' && !!label.json.labelUrl, `Etiqueta gerada (${label.json.format})`)

  // ── 11. Dashboard reflete o mismatch ────────────────────────────────────
  const dash = await call(token, 'GET', `/fulfillment/dashboard?warehouse_id=${warehouseId}`)
  assert((dash.json.mismatch24h ?? 0) >= 1, 'Dashboard registrou o erro de bipagem (mismatch24h ≥ 1)')

  const admin = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } })

  // ── 12. Sprint 1: settings de auto-ingestão (PUT/GET) ────────────────────
  const before = await call(token, 'GET', '/fulfillment/settings')
  const origEnabled = before.json.auto_ingest_enabled
  await call(token, 'PUT', '/fulfillment/settings', { auto_ingest_enabled: true, default_warehouse_id: warehouseId }, 200)
  const afterS = await call(token, 'GET', '/fulfillment/settings')
  assert(afterS.json.auto_ingest_enabled === true && afterS.json.default_warehouse_id === warehouseId, 'Settings de auto-ingestão salvas (PUT/GET)')
  await call(token, 'PUT', '/fulfillment/settings', { auto_ingest_enabled: origEnabled, default_warehouse_id: null }, 200) // restaura

  // ── 13. Sprint 1: idempotência da ingestão (re-seed do mesmo pedido) ─────
  const { data: sfo } = await admin.from('storefront_orders').insert({
    organization_id: ORG, store_slug: 'smoke-f12', customer: { name: 'Smoke SF' },
    items: [{ productId: 'SMOKE-SF-1', name: 'Item SF', price: 10, qty: 1 }],
    subtotal: 10, total: 10, status: 'paid',
  }).select('id').single()
  const sfId = sfo.id
  const seed1 = await call(token, 'POST', '/fulfillment/pick-tasks/seed', { source: 'storefront', orderId: sfId, warehouseId }, 201)
  const seed2 = await call(token, 'POST', '/fulfillment/pick-tasks/seed', { source: 'storefront', orderId: sfId, warehouseId }, 201)
  assert(seed1.json.created === true && seed2.json.created === false && seed1.json.fulfillmentOrderId === seed2.json.fulfillmentOrderId, 'Ingestão idempotente (re-seed não duplica)')
  await admin.from('fulfillment_orders').delete().eq('id', seed1.json.fulfillmentOrderId)
  await admin.from('storefront_orders').delete().eq('id', sfId)

  // ── 14. Limpeza: apaga o fulfillment_order de teste (cascade) ────────────
  await admin.from('fulfillment_orders').delete().eq('id', foId)
  ok('Dados de teste limpos (fulfillment_orders + storefront_order removidos)')

  // ── Resultado ────────────────────────────────────────────────────────────
  console.log(`\n  ${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passaram, ${fail} falharam\x1b[0m\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(`\n\x1b[31m[smoke-f12] ERRO: ${e.message}\x1b[0m\n`)
  process.exit(1)
})
