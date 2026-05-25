#!/usr/bin/env node
/**
 * Verifica na FONTE que o piloto aplicou de verdade:
 *  (1) descrição NOVA viva no ML + título intacto + sold_quantity (via token ML)
 *  (2) ai_optimizer_versions + ai_optimizer_baselines gravados (via service key)
 *
 * Uso: node scripts/pilot-verify.mjs
 */
import { config } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
const ORG = '4ef1aabd-c209-40b0-b034-ef69dcb66833'

// 5 do piloto: a Torneira (já aplicada antes) + os 4 de hoje.
const PILOT = [
  { sku: '2022056P (Torneira)', mlb: 'MLB6724011156' },
  { sku: 'CD251228',           mlb: 'MLB6501371484' },
  { sku: 'CD202130/1D',        mlb: 'MLB4028447447' },
  { sku: 'CD2024073144D',      mlb: 'MLB6291269794' },
  { sku: '2022056G',           mlb: 'MLB5918499510' },
]

async function sql(query) {
  const res = await fetch(`${SUPA.replace(/\/+$/, '')}/rest/v1/rpc/_admin_query_sql`, {
    method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: query }),
  })
  const body = await res.json()
  if (!Array.isArray(body)) throw new Error(`query falhou: ${JSON.stringify(body).slice(0, 300)}`)
  return body
}

async function mlTokens() {
  const rows = await sql(`SELECT access_token FROM ml_connections WHERE organization_id='${ORG}' AND access_token IS NOT NULL`)
  return rows.map(r => r.access_token)
}

async function mlState(mlb, tokens) {
  for (const t of tokens) {
    try {
      const it = await fetch(`https://api.mercadolibre.com/items/${mlb}?attributes=title,sold_quantity,status`, { headers: { Authorization: `Bearer ${t}` } })
      if (it.status !== 200) continue
      const ij = await it.json()
      const dr = await fetch(`https://api.mercadolibre.com/items/${mlb}/description`, { headers: { Authorization: `Bearer ${t}` } })
      const dj = dr.status === 200 ? await dr.json() : {}
      return { title: ij.title, sold: ij.sold_quantity, status: ij.status, descLen: String(dj.plain_text ?? '').length }
    } catch { /* próximo token */ }
  }
  return { error: true }
}

async function main() {
  const tokens = await mlTokens()
  // Versões + baselines de cada listing.
  const rows = await sql(`
    SELECT v.listing_id,
           MAX(v.version_number) FILTER (WHERE NOT v.was_rollback) AS last_ver,
           COUNT(*) FILTER (WHERE NOT v.was_rollback) AS applies,
           COUNT(*) FILTER (WHERE v.was_rollback) AS rollbacks,
           (SELECT b.snapshot_json FROM ai_optimizer_baselines b WHERE b.listing_id = v.listing_id ORDER BY b.id DESC LIMIT 1) AS baseline
    FROM ai_optimizer_versions v
    WHERE v.org_id='${ORG}' AND v.listing_id IN (${PILOT.map(p => `'${p.mlb}'`).join(',')})
    GROUP BY v.listing_id`)
  const byMlb = Object.fromEntries(rows.map(r => [r.listing_id, r]))

  console.log(`\n=== Verificação do piloto (5 anúncios) ===\n`)
  for (const p of PILOT) {
    const ml = await mlState(p.mlb, tokens)
    const db = byMlb[p.mlb]
    const bl = db?.baseline || {}
    console.log(`── ${p.sku} (${p.mlb}) ──`)
    if (ml.error) console.log(`  ML: erro de leitura`)
    else console.log(`  ML: status=${ml.status} sold=${ml.sold} descrição=${ml.descLen} chars | título: "${String(ml.title).slice(0, 55)}"`)
    if (!db) console.log(`  DB: SEM versão registrada ⚠️`)
    else console.log(`  DB: v${db.last_ver} | applies=${db.applies} rollbacks=${db.rollbacks} | baseline: score=${bl.geo_score ?? '?'} visitas14d=${bl.visits_14d ?? '?'} unid14d=${bl.units_14d ?? '?'} receita14d=${bl.revenue_14d ?? '?'}`)
    console.log('')
  }
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1) })
