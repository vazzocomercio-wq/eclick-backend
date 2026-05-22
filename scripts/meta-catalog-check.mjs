#!/usr/bin/env node
/**
 * Diagnóstico: conta produtos REAIS num catálogo Meta + amostra.
 * Lê access_token + external_catalog_id do canal no DB (via _admin_query_sql),
 * depois chama Graph API GET /{catalog_id}/products.
 *
 * Uso: node scripts/meta-catalog-check.mjs <org_id> [channel]
 *   channel default = instagram_shop
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA_URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
const orgId = process.argv[2]
const channel = process.argv[3] ?? 'instagram_shop'
if (!orgId) { console.error('Uso: node scripts/meta-catalog-check.mjs <org_id> [channel]'); process.exit(1) }

async function q(sql) {
  const res = await fetch(`${SUPA_URL.replace(/\/+$/, '')}/rest/v1/rpc/_admin_query_sql`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  })
  return res.json()
}

const rows = await q(`SELECT access_token, external_catalog_id FROM social_commerce_channels WHERE organization_id = '${orgId}' AND channel = '${channel}' LIMIT 1`)
if (!Array.isArray(rows) || !rows.length) { console.error('Canal não encontrado'); process.exit(1) }
const { access_token, external_catalog_id } = rows[0]
console.log(`Catálogo: ${external_catalog_id}`)

// 1) Contagem total
const countUrl = `https://graph.facebook.com/v19.0/${external_catalog_id}/products?summary=total_count&limit=0&access_token=${access_token}`
const countRes = await fetch(countUrl)
const countBody = await countRes.json()
if (!countRes.ok) {
  console.error(`[meta] HTTP ${countRes.status}:`, JSON.stringify(countBody, null, 2))
  process.exit(1)
}
console.log(`Total de produtos no catálogo Meta: ${countBody.summary?.total_count ?? '???'}`)

// 2) Amostra de 3 com campos
const sampleUrl = `https://graph.facebook.com/v19.0/${external_catalog_id}/products?fields=name,price,image_url,url,availability,review_status,errors&limit=3&access_token=${access_token}`
const sampleRes = await fetch(sampleUrl)
const sampleBody = await sampleRes.json()
console.log('\nAmostra (3 produtos):')
console.log(JSON.stringify(sampleBody.data ?? sampleBody, null, 2))
