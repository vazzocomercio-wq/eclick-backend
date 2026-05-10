#!/usr/bin/env node
/**
 * Smoke test v2 — Sprint 0 do F10 ML Listing Center.
 * Refinamento: agora usa items que SABEMOS ter dados:
 *  - Pra /suggestions/items/{id} → primeiro item da lista de items com sugestão
 *  - Pra /pricing-automation/items/{id}/automation → primeiro item automatizado
 *
 * 404 nesses endpoints quando o item não tem sugestão/automação é
 * comportamento esperado, não bug. Esse script confirma isso.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA_URL = process.env.SUPABASE_URL
const SVC_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY
const ML_CLIENT_ID     = process.env.ML_CLIENT_ID
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET
const ORG_ID    = '4ef1aabd-c209-40b0-b034-ef69dcb66833'
const SELLER_ID = 2290161131

const admin = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } })

const { data: conn } = await admin
  .from('ml_connections')
  .select('access_token, refresh_token, expires_at')
  .eq('organization_id', ORG_ID).eq('seller_id', SELLER_ID).maybeSingle()

let token = conn.access_token
if (new Date(conn.expires_at) <= new Date(Date.now() + 60_000)) {
  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: conn.refresh_token,
    }),
  })
  const j = await r.json()
  token = j.access_token
  await admin.from('ml_connections').update({
    access_token: j.access_token, refresh_token: j.refresh_token,
    expires_at: new Date(Date.now() + j.expires_in * 1000).toISOString(),
  }).eq('organization_id', ORG_ID).eq('seller_id', SELLER_ID)
}

async function get(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const text = await res.text()
  let body; try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

console.log('═'.repeat(70))
console.log('F10 SMOKE TEST v2 · re-checa 404s com sample correto')
console.log('═'.repeat(70))
console.log()

// 1. Pega 1 item COM sugestão (da lista do endpoint #1)
const lst = await get(`https://api.mercadolibre.com/suggestions/user/${SELLER_ID}/items`)
const itemComSugestao = lst.body.items?.[0]
console.log(`Item com sugestão: ${itemComSugestao} (1 de ${lst.body.total} disponíveis)`)

const sug = await get(`https://api.mercadolibre.com/suggestions/items/${itemComSugestao}`)
console.log(`\n▸ /suggestions/items/${itemComSugestao}`)
console.log(`  HTTP ${sug.status}`)
if (sug.status < 300) {
  console.log('  shape:')
  console.log('  ' + JSON.stringify(sug.body, null, 2).split('\n').slice(0, 80).join('\n  '))
} else {
  console.log('  body:', JSON.stringify(sug.body).slice(0, 500))
}

// 2. Pega 1 item AUTOMATIZADO (da lista do endpoint #5)
const aut = await get(`https://api.mercadolibre.com/pricing-automation/users/${SELLER_ID}/items`)
const itemAutomatizado = aut.body.items?.[0]
console.log(`\nItem automatizado: ${itemAutomatizado}`)

const stat = await get(`https://api.mercadolibre.com/pricing-automation/items/${itemAutomatizado}/automation`)
console.log(`\n▸ /pricing-automation/items/${itemAutomatizado}/automation`)
console.log(`  HTTP ${stat.status}`)
if (stat.status < 300) {
  console.log('  shape:')
  console.log('  ' + JSON.stringify(stat.body, null, 2).split('\n').slice(0, 60).join('\n  '))
} else {
  console.log('  body:', JSON.stringify(stat.body).slice(0, 500))
}
