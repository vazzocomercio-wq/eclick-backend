#!/usr/bin/env node
/**
 * Lista candidatos pro piloto do GEO Optimizer (Dia 12), pra aprovação manual.
 * Critério (salvaguarda #2): GEO Score 10-25, venda > 0 no baseline (pré ≠ 0),
 * FORA do top-20 em vendas (30d), com flag de sazonalidade (Dia das Mães).
 *
 * Uso: node scripts/optimizer-candidates.mjs
 */
import { config } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const ORG = '4ef1aabd-c209-40b0-b034-ef69dcb66833'
const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY

// Palavras que sugerem categoria com pico no Dia das Mães (10/maio) → flag.
const SEASONAL = ['cabeceira', 'romant', 'presente', 'namorad', 'kit ', 'quarto casal', 'abajur de mesa']

async function sql(query) {
  const res = await fetch(`${SUPA.replace(/\/+$/, '')}/rest/v1/rpc/_admin_query_sql`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: query }),
  })
  const body = await res.json()
  if (!Array.isArray(body)) throw new Error(`query falhou: ${JSON.stringify(body).slice(0, 300)}`)
  return body
}

const Q = `
WITH latest AS (
  SELECT DISTINCT ON (j.url) j.url, r.geo_score, r.raw_scraped_data->>'category' AS category
  FROM ai_audit_results r JOIN ai_audit_jobs j ON j.id = r.job_id
  WHERE j.org_id = '${ORG}' AND j.status = 'completed' AND j.deleted_at IS NULL AND r.geo_score IS NOT NULL
  ORDER BY j.url, r.created_at DESC
),
top20 AS (
  SELECT product_id FROM product_sales_snapshots
  WHERE organization_id = '${ORG}' AND snapshot_date >= CURRENT_DATE - 30
  GROUP BY product_id ORDER BY SUM(units_sold) DESC LIMIT 20
),
s30 AS (
  SELECT product_id, SUM(units_sold) AS u30, SUM(revenue) AS r30
  FROM product_sales_snapshots
  WHERE organization_id = '${ORG}' AND snapshot_date >= CURRENT_DATE - 30
  GROUP BY product_id
)
SELECT p.sku, pl.listing_id, COALESCE(latest.category,'(n/d)') AS category, latest.geo_score::int AS geo_score,
       COALESCE(s.u30,0)::int AS units_30d, ROUND(COALESCE(s.r30,0)::numeric,2) AS revenue_30d,
       lower(coalesce(pl.listing_title,'')) AS title_lc, latest.url
FROM latest
JOIN product_listings pl ON pl.listing_permalink = latest.url
JOIN products p ON p.id = pl.product_id
LEFT JOIN s30 s ON s.product_id = pl.product_id
WHERE latest.geo_score BETWEEN 10 AND 30
  AND pl.product_id NOT IN (SELECT product_id FROM top20)
  AND COALESCE(s.u30,0) > 0
ORDER BY latest.geo_score ASC, units_30d DESC
LIMIT 50`

async function main() {
  const rows = await sql(Q)
  const enriched = rows.map(r => ({
    ...r,
    seasonal: SEASONAL.some(k => (r.title_lc || '').includes(k)),
  }))
  const safe = enriched.filter(r => !r.seasonal)

  console.log(`\n=== Candidatos GEO Optimizer (piloto) — score 10-30, venda(30d)>0, fora do top-20 ===`)
  console.log(`Total elegíveis: ${enriched.length} | sem flag sazonal: ${safe.length}`)
  console.log(`\nSKU | listing | categoria | score | unid30d | receita30d | sazonal?`)
  console.log('-'.repeat(90))
  for (const r of enriched.slice(0, 30)) {
    console.log(`${r.sku} | ${r.listing_id} | ${(r.category || '').slice(0, 22).padEnd(22)} | ${String(r.geo_score).padStart(3)} | ${String(r.units_30d).padStart(4)} | R$${String(r.revenue_30d).padStart(8)} | ${r.seasonal ? '⚠️ Dia das Mães' : 'ok'}`)
  }
  console.log(`\n→ Diversificar categorias + preferir 'ok' (não-sazonal) + baseline de vendas saudável.`)
  console.log(`→ Aprovar 5. URLs dos não-sazonais:`)
  safe.slice(0, 12).forEach(r => console.log(`   [${r.geo_score}] ${r.sku}: ${r.url}`))
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1) })
