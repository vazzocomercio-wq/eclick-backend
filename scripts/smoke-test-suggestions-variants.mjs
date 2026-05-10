#!/usr/bin/env node
/**
 * Smoke test do endpoint /suggestions/items/{id} — testa variações
 * de path porque a versão "canônica" (per spec F10) está retornando 404.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
const ORG_ID    = '4ef1aabd-c209-40b0-b034-ef69dcb66833'
const SELLER_ID = 2290161131
const { data: conn } = await admin.from('ml_connections')
  .select('access_token, expires_at, refresh_token')
  .eq('organization_id', ORG_ID).eq('seller_id', SELLER_ID).maybeSingle()

let token = conn.access_token
if (new Date(conn.expires_at) <= new Date(Date.now() + 60_000)) {
  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ML_CLIENT_ID, client_secret: process.env.ML_CLIENT_SECRET,
      refresh_token: conn.refresh_token,
    }),
  })
  const j = await r.json(); token = j.access_token
}

const ITEM_ID = 'MLB5406302054'  // confirmado na lista de items com sugestão

async function probe(label, url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const text = await res.text()
  let body; try { body = JSON.parse(text) } catch { body = text }
  const ok = res.status < 300
  const preview = ok ? JSON.stringify(body, null, 2).slice(0, 800) : (typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 200)
  console.log(`${ok ? '✓' : '✗'} ${res.status}  ${label}`)
  console.log(`     ${url}`)
  console.log(`     ${preview.split('\n').join('\n     ')}\n`)
  return { ok, status: res.status, body }
}

console.log(`Testando variações pra item ${ITEM_ID}\n`)

// Spec original
await probe('A. spec original',                  `https://api.mercadolibre.com/suggestions/items/${ITEM_ID}`)
// Variações com /users/
await probe('B. com /users/{seller}/items/',     `https://api.mercadolibre.com/users/${SELLER_ID}/suggestions/items/${ITEM_ID}`)
await probe('C. /suggestions/users/{seller}/items/', `https://api.mercadolibre.com/suggestions/users/${SELLER_ID}/items/${ITEM_ID}`)
// Detail no /items/
await probe('D. /items/{id}/suggestions',         `https://api.mercadolibre.com/items/${ITEM_ID}/suggestions`)
// Talvez plural diferente
await probe('E. /suggestions/{id} sem /items',    `https://api.mercadolibre.com/suggestions/${ITEM_ID}`)
// Talvez query string
await probe('F. /suggestions/items?id=',          `https://api.mercadolibre.com/suggestions/items?id=${ITEM_ID}`)
// Public API style com user_id
await probe('G. /suggestions/items/{id}?user_id=', `https://api.mercadolibre.com/suggestions/items/${ITEM_ID}?user_id=${SELLER_ID}`)
// Talvez batch
await probe('H. POST /suggestions/items batch',   `https://api.mercadolibre.com/suggestions/items?ids=${ITEM_ID}`)
// Pricing endpoint relacionado
await probe('I. /items/{id}/prices',              `https://api.mercadolibre.com/items/${ITEM_ID}/prices`)
await probe('J. /items/{id}/price_to_win',        `https://api.mercadolibre.com/items/${ITEM_ID}/price_to_win`)
