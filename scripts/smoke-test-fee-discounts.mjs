#!/usr/bin/env node
/**
 * Smoke test pra descobrir o endpoint ML que expõe "Menos tarifas de venda"
 * (campanha de redução de tarifa ML, diferente das promoções de desconto
 * pro consumidor que vêm em /seller-promotions/promotions).
 *
 * Hipóteses a testar:
 *   - /sites/MLB/marketplace_deals
 *   - /seller-promotions/users/{id}/promotions
 *   - /sale-fee-discounts
 *   - /users/{id}/sale-fee-discounts
 *   - /seller-promotions/promotions?app_version=v2 com vários types
 *   - /sites/MLB/sale-fee-promotions
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') })

const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } },
)

const SELLER_ID = 2290161131

const { data: c } = await admin
  .from('ml_connections')
  .select('access_token')
  .eq('seller_id', SELLER_ID)
  .maybeSingle()

if (!c?.access_token) { console.error('sem token'); process.exit(1) }
const TOKEN = c.access_token

async function probe(label, url) {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })
    const text = await r.text()
    let body; try { body = JSON.parse(text) } catch { body = text }
    const sizeKb = (text.length / 1024).toFixed(1)
    console.log(`━━━ ${label}`)
    console.log(`  ${url}`)
    console.log(`  HTTP ${r.status} (${sizeKb}kb)`)

    if (r.status >= 400) {
      console.log(`  err: ${(typeof body === 'object' ? JSON.stringify(body) : String(body)).slice(0, 200)}`)
    } else if (typeof body === 'string') {
      console.log(`  preview: ${body.slice(0, 200)}`)
    } else {
      const preview = JSON.stringify(body, null, 2)
      console.log(`  body: ${preview.slice(0, 800)}`)
      // Busca palavras-chave "menos", "tarifa", "fee", "discount"
      const matches = preview.toLowerCase().match(/menos|tarifa|fee_discount|sale_fee|less_fee|seller_fee/g)
      if (matches) console.log(`  🎯 matches keywords: ${[...new Set(matches)].join(', ')}`)
    }
    console.log()
  } catch (e) {
    console.log(`✗ ${label}: ${e.message}\n`)
  }
}

const targets = [
  // Variações de /seller-promotions
  ['A. seller-promotions com type=MARKETPLACE',           `https://api.mercadolibre.com/seller-promotions/promotions?app_version=v2&promotion_type=MARKETPLACE_CAMPAIGN`],
  ['B. seller-promotions sem version',                    `https://api.mercadolibre.com/seller-promotions/promotions`],
  ['C. seller-promotions/users/{id}/promotions',          `https://api.mercadolibre.com/seller-promotions/users/${SELLER_ID}/promotions`],
  // Fee discount candidates
  ['D. sale-fee-discounts (root)',                        `https://api.mercadolibre.com/sale-fee-discounts`],
  ['E. users/{id}/sale-fee-discounts',                    `https://api.mercadolibre.com/users/${SELLER_ID}/sale-fee-discounts`],
  ['F. sites/MLB/sale-fee-promotions',                    `https://api.mercadolibre.com/sites/MLB/sale-fee-promotions`],
  ['G. sites/MLB/marketplace_deals',                      `https://api.mercadolibre.com/sites/MLB/marketplace_deals`],
  // Benefits / programs
  ['H. users/{id}/benefits',                              `https://api.mercadolibre.com/users/${SELLER_ID}/benefits`],
  ['I. seller-benefits',                                  `https://api.mercadolibre.com/seller-benefits`],
  // Discounts
  ['J. sites/MLB/seller-promotions',                      `https://api.mercadolibre.com/sites/MLB/seller-promotions`],
  // Sponsored / paid programs
  ['K. campaigns/promotions/all',                         `https://api.mercadolibre.com/seller-promotions/promotions?app_version=v2&type=ALL`],
]

for (const [label, url] of targets) await probe(label, url)
