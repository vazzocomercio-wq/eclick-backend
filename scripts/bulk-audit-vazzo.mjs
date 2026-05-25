#!/usr/bin/env node
/**
 * Bulk GEO Score — audita os listings ativos da Vazzo via a API
 * POST /ai-visibility/score, espera completar, e exporta CSV + resumo.
 *
 * Uso:
 *   node scripts/bulk-audit-vazzo.mjs --dry-run            # só conta + estima custo
 *   node scripts/bulk-audit-vazzo.mjs --dry-run --limit 20 # estima pra um subset
 *   node scripts/bulk-audit-vazzo.mjs --limit 20           # roda de verdade (20)
 *   node scripts/bulk-audit-vazzo.mjs --confirm            # roda TUDO (exigido se est > $50)
 *
 * Cache 24h: listings já auditados nas últimas 24h voltam do cache (custo $0).
 * CSV vai pra os.tmpdir() (não /tmp — portável no Windows).
 */
import { config } from 'dotenv'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const ORG     = '4ef1aabd-c209-40b0-b034-ef69dcb66833'
const SUPA    = process.env.SUPABASE_URL
const KEY     = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
const BACKEND = process.env.BACKEND_URL ?? 'https://eclick-backend-production-2a87.up.railway.app'

const DRY      = process.argv.includes('--dry-run')
const CONFIRM  = process.argv.includes('--confirm')
const limitArg = process.argv.find(a => a.startsWith('--limit'))
const LIMIT    = limitArg ? parseInt((limitArg.split('=')[1] ?? process.argv[process.argv.indexOf(limitArg) + 1]), 10) || null : null

const COST_PER_LISTING = 0.10   // estimativa conservadora do spec (real observado ~$0.06)
const COST_GATE        = 50
const BATCH            = 5
const BATCH_DELAY_MS   = 10_000
const POLL_MS          = 10_000
const TIMEOUT_MS       = 30 * 60_000

const DIM_LABEL = {
  title_geo: 'Título p/ IA', description_depth: 'Profundidade descrição',
  entity_coverage: 'Cobertura entidades', semantic_density: 'Densidade semântica',
  structured_data: 'Dados estruturados', review_architecture: 'Arquitetura reviews',
  faq_presence: 'Presença FAQ', crawler_access: 'Acesso bots IA',
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function sql(query) {
  const res = await fetch(`${SUPA.replace(/\/+$/, '')}/rest/v1/rpc/_admin_query_sql`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: query }),
  })
  const body = await res.json()
  if (!Array.isArray(body)) throw new Error(`query falhou: ${JSON.stringify(body).slice(0, 200)}`)
  return body
}

async function getListings() {
  const lim = LIMIT ? `LIMIT ${LIMIT}` : ''
  return sql(`
    SELECT p.sku AS sku, pl.listing_id, pl.platform, pl.listing_permalink AS url,
           left(coalesce(pl.listing_title,''), 100) AS title
    FROM product_listings pl JOIN products p ON p.id = pl.product_id
    WHERE p.organization_id = '${ORG}' AND pl.is_active = true
      AND pl.platform IN ('mercadolivre','shopee') AND pl.listing_permalink IS NOT NULL
    ORDER BY pl.listing_id ${lim}`)
}

/** Quantos desses já têm auditoria completed < 24h (viriam do cache, custo $0). */
async function countCached(urls) {
  if (urls.length === 0) return 0
  const inList = urls.map(u => `'${u.replace(/'/g, "''")}'`).join(',')
  const rows = await sql(`
    SELECT count(DISTINCT url) AS n FROM ai_audit_jobs
    WHERE org_id='${ORG}' AND status='completed' AND deleted_at IS NULL
      AND completed_at > now() - interval '24 hours' AND url IN (${inList})`)
  return Number(rows[0]?.n ?? 0)
}

function mintToken() {
  const out = execSync('node scripts/mint-jwt.mjs vazzocomercio@gmail.com', { cwd: path.resolve(here, '..') }).toString()
  const token = out.trim().split('\n').pop().trim()
  if (!token || token.length < 100) throw new Error('mint-jwt não retornou token válido')
  return token
}

const csvCell = v => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function worstDims(breakdown) {
  if (!Array.isArray(breakdown)) return ['', '', '']
  const sorted = [...breakdown].sort((a, b) => b.weight * (10 - b.score) - a.weight * (10 - a.score))
  return [0, 1, 2].map(i => sorted[i] ? `${DIM_LABEL[sorted[i].name] ?? sorted[i].name} (${sorted[i].score})` : '')
}

function pct(n, total) { return total ? ((n / total) * 100).toFixed(1) : '0.0' }

async function main() {
  if (!SUPA || !KEY) { console.error('FATAL: SUPABASE_URL/KEY ausentes no .env'); process.exit(1) }
  const t0 = Date.now()

  console.log(`\n=== Bulk GEO Score — Vazzo ===`)
  const listings = await getListings()
  const n = listings.length
  const cached = await countCached(listings.map(l => l.url))
  const fresh = Math.max(0, n - cached)
  const estCost = fresh * COST_PER_LISTING

  console.log(`Listings a processar: ${n}${LIMIT ? ` (--limit ${LIMIT})` : ' (todos ativos ML/Shopee)'}`)
  console.log(`Já em cache (<24h, custo $0): ${cached}`)
  console.log(`Novos a auditar: ${fresh}`)
  console.log(`Custo estimado: ~$${estCost.toFixed(2)} (a $${COST_PER_LISTING}/listing; real observado ~$0.06 → ~$${(fresh * 0.06).toFixed(2)})`)
  const postMin = Math.ceil((n / BATCH) * (BATCH_DELAY_MS / 1000) / 60)
  console.log(`Tempo estimado: ~${postMin}+ min (disparo em lotes + processamento; pode estender por rate limit da IA)`)

  if (DRY) {
    console.log(`\n[DRY-RUN] Nada foi disparado. Pra rodar de verdade:`)
    console.log(`  node scripts/bulk-audit-vazzo.mjs${LIMIT ? ` --limit ${LIMIT}` : ''}${estCost > COST_GATE ? ' --confirm' : ''}`)
    if (estCost > COST_GATE) console.log(`  ⚠️ custo estimado > $${COST_GATE} → exige --confirm`)
    process.exit(0)
  }

  if (estCost > COST_GATE && !CONFIRM) {
    console.error(`\n⚠️ ABORTADO: custo estimado ~$${estCost.toFixed(2)} > $${COST_GATE}. Rode com --confirm pra prosseguir (ou --limit N pra um subset).`)
    process.exit(1)
  }
  if (n === 0) { console.log('Nada a fazer.'); process.exit(0) }

  const token = mintToken()
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  // 1. Dispara em lotes de 5, 10s entre lotes.
  const jobs = [] // { sku, listing_id, platform, title, url, jobId }
  for (let i = 0; i < listings.length; i += BATCH) {
    const batch = listings.slice(i, i + BATCH)
    await Promise.all(batch.map(async l => {
      try {
        const r = await fetch(`${BACKEND}/ai-visibility/score`, { method: 'POST', headers, body: JSON.stringify({ url: l.url }) })
        const d = await r.json()
        if (d.jobId) jobs.push({ ...l, jobId: d.jobId })
      } catch (e) { console.error(`  POST falhou ${l.sku}: ${e.message}`) }
    }))
    console.log(`disparados ${Math.min(i + BATCH, listings.length)}/${listings.length}`)
    if (i + BATCH < listings.length) await sleep(BATCH_DELAY_MS)
  }

  // 2. Poll até todos completarem (ou timeout).
  const results = new Map() // jobId -> detail
  const deadline = Date.now() + TIMEOUT_MS
  while (results.size < jobs.length && Date.now() < deadline) {
    await sleep(POLL_MS)
    for (const j of jobs) {
      if (results.has(j.jobId)) continue
      try {
        const r = await fetch(`${BACKEND}/ai-visibility/score/${j.jobId}`, { headers })
        if (r.ok) {
          const d = await r.json()
          if (d.status === 'completed' || d.status === 'failed') results.set(j.jobId, d)
        }
      } catch { /* retry no próximo poll */ }
    }
    console.log(`${results.size}/${jobs.length} listings analisados`)
  }

  // 3. CSV (ordenado por geo_score ASC — piores primeiro).
  const rows = jobs.map(j => {
    const d = results.get(j.jobId) ?? {}
    const wd = worstDims(d.breakdown)
    const recs = Array.isArray(d.recommendations) ? d.recommendations : []
    return {
      sku: j.sku, listing_id: j.listing_id, platform: j.platform, title: j.title, url: j.url,
      geo_score: typeof d.score === 'number' ? d.score : '',
      wd1: wd[0], wd2: wd[1], wd3: wd[2],
      r1s: recs[0]?.severity ?? '', r1t: recs[0]?.title ?? '',
      r2s: recs[1]?.severity ?? '', r2t: recs[1]?.title ?? '',
      cost: typeof d.cost_usd === 'number' ? d.cost_usd : 0,
    }
  }).sort((a, b) => (a.geo_score === '' ? 999 : a.geo_score) - (b.geo_score === '' ? 999 : b.geo_score))

  const head = ['sku', 'listing_id', 'platform', 'title', 'url', 'geo_score', 'worst_dimension_1', 'worst_dimension_2', 'worst_dimension_3', 'recommendation_1_severity', 'recommendation_1_title', 'recommendation_2_severity', 'recommendation_2_title']
  const lines = [head.join(',')]
  for (const r of rows) lines.push([r.sku, r.listing_id, r.platform, r.title, r.url, r.geo_score, r.wd1, r.wd2, r.wd3, r.r1s, r1clean(r.r1t), r.r2s, r1clean(r.r2t)].map(csvCell).join(','))
  const date = new Date().toISOString().slice(0, 10)
  const csvPath = path.join(os.tmpdir(), `vazzo-audit-${date}.csv`)
  fs.writeFileSync(csvPath, lines.join('\n'), 'utf8')

  // 4. Resumo.
  const scored = rows.filter(r => typeof r.geo_score === 'number')
  const avg = scored.length ? (scored.reduce((s, r) => s + r.geo_score, 0) / scored.length).toFixed(1) : '—'
  const band = (lo, hi) => scored.filter(r => r.geo_score >= lo && r.geo_score <= hi).length
  const totalCost = rows.reduce((s, r) => s + (r.cost || 0), 0)
  const failed = jobs.length - scored.length

  console.log(`\n=== RESUMO ===`)
  console.log(`Analisados: ${scored.length}/${jobs.length}${failed ? ` (${failed} sem score/falha)` : ''}`)
  console.log(`Média GEO Score: ${avg}`)
  console.log(`  0-30 (crítico):  ${band(0, 30)} (${pct(band(0, 30), scored.length)}%)`)
  console.log(`  31-60:           ${band(31, 60)} (${pct(band(31, 60), scored.length)}%)`)
  console.log(`  61-80:           ${band(61, 80)} (${pct(band(61, 80), scored.length)}%)`)
  console.log(`  81-100:          ${band(81, 100)} (${pct(band(81, 100), scored.length)}%)`)
  console.log(`\nTop 10 piores:`)
  scored.slice(0, 10).forEach((r, i) => console.log(`  ${i + 1}. ${r.sku} — ${r.geo_score}`))
  console.log(`\nCusto total: $${totalCost.toFixed(4)}`)
  console.log(`Tempo total: ${((Date.now() - t0) / 60000).toFixed(1)} min`)
  console.log(`CSV: ${csvPath}`)
}

// title pode ter vírgula/quebra — csvCell já trata; helper só apara
function r1clean(s) { return String(s ?? '').slice(0, 200) }

main().catch(e => { console.error('ERRO:', e.message); process.exit(1) })
