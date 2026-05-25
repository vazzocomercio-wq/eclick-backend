#!/usr/bin/env node
/**
 * Candidatos do piloto GEO Optimizer — ENRIQUECIDO com sold_quantity REAL do anúncio.
 *
 * Correção do critério (bug do piloto): o script anterior filtrava por venda no
 * nível do PRODUTO (product_sales_snapshots). Mas anúncios duplicados em conta
 * secundária têm sold_quantity=0 no PRÓPRIO anúncio → baseline de vendas vazio
 * + título travado em conta cruzada. O piloto precisa de anúncios com VENDA REAL
 * no próprio listing (como a Torneira MLB6724011156, sold=4).
 *
 * Aqui: pega o pool de candidatos e busca sold_quantity/status direto na API ML
 * (iterando os tokens das contas). Mantém só sold_quantity>0, active, com estoque.
 *
 * Uso: node scripts/optimizer-candidates-enriched.mjs
 */
import { config } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const ORG = '4ef1aabd-c209-40b0-b034-ef69dcb66833'
const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY

// Já aplicado (não repropor).
const ALREADY_APPLIED = new Set(['MLB6724011156'])

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

async function mlTokens() {
  const rows = await sql(`
    SELECT seller_id, access_token FROM ml_connections
    WHERE organization_id = '${ORG}' AND access_token IS NOT NULL`)
  return rows.map(r => ({ sellerId: String(r.seller_id), token: r.access_token }))
}

/** Busca sold_quantity/status do anúncio iterando tokens até um 200. */
async function mlItem(mlb, tokens) {
  let lastStatus = null
  for (const t of tokens) {
    try {
      const res = await fetch(
        `https://api.mercadolibre.com/items/${mlb}?attributes=id,sold_quantity,available_quantity,status,seller_id`,
        { headers: { Authorization: `Bearer ${t.token}` } },
      )
      lastStatus = res.status
      if (res.status === 200) {
        const j = await res.json()
        return {
          sold:   Number(j.sold_quantity ?? 0),
          avail:  Number(j.available_quantity ?? 0),
          status: String(j.status ?? ''),
          seller: String(j.seller_id ?? ''),
          ownerToken: t.token,
        }
      }
    } catch { /* tenta próximo token */ }
  }
  return { error: lastStatus ?? 'fetch_fail' }
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
WHERE latest.geo_score BETWEEN 10 AND 35
  AND pl.product_id NOT IN (SELECT product_id FROM top20)
ORDER BY latest.geo_score ASC, units_30d DESC
LIMIT 120`

async function main() {
  const [rows, tokens] = await Promise.all([sql(Q), mlTokens()])
  console.log(`Pool de candidatos (score 10-35, fora do top-20): ${rows.length} | contas ML: ${tokens.length}`)

  const enriched = []
  for (const r of rows) {
    const mlb = r.listing_id
    if (!/^MLB\d+/.test(mlb || '')) continue
    if (ALREADY_APPLIED.has(mlb)) continue
    const m = await mlItem(mlb, tokens)
    const seasonal = SEASONAL.some(k => (r.title_lc || '').includes(k))
    enriched.push({ ...r, ...m, seasonal })
  }

  // Limpos = venda REAL no anúncio + ativo + com estoque + não-sazonal.
  const clean = enriched.filter(r =>
    !r.error && r.sold > 0 && r.status === 'active' && r.avail > 0 && !r.seasonal,
  ).sort((a, b) => b.sold - a.sold)

  console.log(`\n=== Anúncios LIMPOS (sold_quantity>0 no próprio anúncio, ativo, c/ estoque, não-sazonal) ===`)
  console.log(`Total limpos: ${clean.length}\n`)
  console.log(`SKU | MLB | categoria | score | sold(anúncio) | unid30d(produto) | receita30d | seller`)
  console.log('-'.repeat(110))
  for (const r of clean.slice(0, 25)) {
    console.log(
      `${(r.sku||'').padEnd(14)} | ${r.listing_id} | ${(r.category || '').slice(0, 20).padEnd(20)} | ${String(r.geo_score).padStart(3)} | ` +
      `${String(r.sold).padStart(5)} | ${String(r.units_30d).padStart(5)} | R$${String(r.revenue_30d).padStart(8)} | ${r.seller}`,
    )
  }

  // Diversificar categoria: 1 por categoria primeiro, depois completa.
  const seen = new Set()
  const diversified = []
  for (const r of clean) { if (!seen.has(r.category)) { seen.add(r.category); diversified.push(r) } }
  for (const r of clean) { if (diversified.length >= 8) break; if (!diversified.includes(r)) diversified.push(r) }

  console.log(`\n→ Sugestão (4 anúncios limpos, categorias diversas, pra fechar o piloto em 5 com a Torneira):`)
  diversified.slice(0, 4).forEach(r =>
    console.log(`   [score ${r.geo_score}, sold ${r.sold}] ${r.sku} ${r.listing_id} — ${r.category}\n      ${r.url}`),
  )

  // Diagnóstico rápido dos descartados por sold=0 (os duplicados de conta secundária).
  const sold0 = enriched.filter(r => !r.error && r.sold === 0)
  console.log(`\n(diagnóstico) descartados sold=0 no anúncio: ${sold0.length} | erro de leitura: ${enriched.filter(r => r.error).length}`)
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1) })
