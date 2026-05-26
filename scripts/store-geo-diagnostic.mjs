#!/usr/bin/env node
/**
 * Diagnóstico GEO nas páginas de PRODUTO da Loja Própria (vazzo.com.br).
 * Roda o GEO Score (POST /ai-visibility/score, force=true) em cada URL e
 * reporta nota + breakdown das 8 dimensões. Compara com o baseline ML (~35).
 *
 * ⚠️ A loja está atrás do Cloudflare; se o scraper (Railway) for bloqueado,
 * a auditoria volta com skip_reason='blocked_by_marketplace'.
 *
 * Uso: node scripts/store-geo-diagnostic.mjs [--limit N]
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
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? Number(process.argv[i + 1]) : 999 })()

// a732da52 tem FAQ (melhor caso de structured data); resto do sitemap.
const URLS = [
  'https://vazzo.com.br/produto/a732da52-ea5d-47c8-82f4-4aeccddbcb87',
  'https://vazzo.com.br/produto/6e26758e-7540-4b42-a1a7-3f36aba2e37f',
  'https://vazzo.com.br/produto/1e03c0ac-e1a6-4ed4-8ca6-68f62ca11974',
  'https://vazzo.com.br/produto/77e5abaf-e422-42f0-bdda-5529c3145013',
  'https://vazzo.com.br/produto/146a3fe3-1353-41d4-907e-da8829e48e7b',
  'https://vazzo.com.br/produto/9b04216f-22c9-4c5f-8179-b5eeb0f914c6',
  'https://vazzo.com.br/produto/37a8810c-ae17-46aa-840a-46ca4ad517f6',
  'https://vazzo.com.br/produto/6af2d8e2-cfdc-4793-87ac-4c9fc1315ddc',
].slice(0, LIMIT)

async function mintJwt() {
  const g = await fetch(`${SUPA}/auth/v1/admin/generate_link`, {
    method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email: EMAIL }),
  })
  const gj = await g.json(); const hashed = gj?.properties?.hashed_token || gj?.hashed_token
  if (!hashed) throw new Error(`generate_link falhou: ${JSON.stringify(gj).slice(0, 200)}`)
  const v = await fetch(`${SUPA}/auth/v1/verify`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed }),
  })
  const vj = await v.json(); if (!vj.access_token) throw new Error('verify falhou')
  return vj.access_token
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function score(jwt, url) {
  const post = await fetch(`${BACKEND}/ai-visibility/score?force=true`, {
    method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  if (!post.ok) return { url, error: `POST ${post.status}: ${(await post.text()).slice(0, 120)}` }
  const { jobId } = await post.json()
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BACKEND}/ai-visibility/score/${jobId}`, { headers: { Authorization: `Bearer ${jwt}` } })
    if (r.ok) {
      const d = await r.json()
      if (d.status === 'completed') return { url, score: d.score, skip: d.skip_reason, breakdown: d.breakdown }
      if (d.status === 'failed') return { url, error: d.error || 'failed' }
    }
    await sleep(5000)
  }
  return { url, error: 'timeout' }
}

async function main() {
  const jwt = await mintJwt()
  console.log(`\n=== Diagnóstico GEO — Loja (vazzo.com.br) — ${URLS.length} produto(s) ===\n`)
  const results = []
  for (const url of URLS) {
    const slug = url.split('/produto/')[1].slice(0, 8)
    process.stdout.write(`• ${slug}… `)
    const r = await score(jwt, url)
    results.push(r)
    if (r.error) console.log(`ERRO: ${r.error}`)
    else if (r.skip) console.log(`PULADO: ${r.skip}`)
    else {
      const dims = (r.breakdown || []).map(d => `${d.name}=${d.score}`).join(' ')
      console.log(`score ${r.score}/100  [${dims}]`)
    }
  }
  const ok = results.filter(r => typeof r.score === 'number')
  if (ok.length) {
    const avg = (ok.reduce((s, r) => s + r.score, 0) / ok.length).toFixed(1)
    // média por dimensão
    const dimAgg = {}
    for (const r of ok) for (const d of (r.breakdown || [])) { (dimAgg[d.name] ??= []).push(d.score) }
    console.log(`\n=== Resumo ===`)
    console.log(`Pontuados: ${ok.length}/${URLS.length} | média GEO Score LOJA: ${avg}/100  (baseline ML Vazzo ~35)`)
    console.log(`Média por dimensão (0-10):`)
    for (const [n, arr] of Object.entries(dimAgg)) console.log(`  ${n.padEnd(20)} ${(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)}`)
  }
  const bad = results.filter(r => r.error || r.skip)
  if (bad.length) console.log(`\n⚠️ ${bad.length} com erro/skip: ${bad.map(r => r.skip || r.error).join(', ')}`)
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1) })
