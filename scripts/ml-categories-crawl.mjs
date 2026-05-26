#!/usr/bin/env node
/**
 * Crawler da árvore de categorias do Mercado Livre → public.ml_categories.
 *
 * ⚠️ SEGURO: só escreve em `ml_categories`. NUNCA lê/grava em `products`.
 *    Os produtos seguem conectados à categoria do ML via API como hoje.
 *
 * API pública do ML (sem token):
 *   - GET /sites/{site}/categories          → raízes [{id,name}]
 *   - GET /categories/{id}                   → {path_from_root[], children_categories[], total_items_in_this_category}
 *
 * Crawl recursivo (BFS) com throttle + retry. Idempotente (upsert por id) —
 * re-rodar atualiza/continua sem duplicar. Pensado pra rodar 1x agora e como
 * refresh mensal.
 *
 * Uso:
 *   node scripts/ml-categories-crawl.mjs            # MLB (Brasil), tudo
 *   node scripts/ml-categories-crawl.mjs MLB
 *   node scripts/ml-categories-crawl.mjs MLB --limit 200   # teste rápido (para após N nós)
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
if (!SUPA_URL || !SVC_KEY) { console.error('[ml-cat] FATAL: SUPABASE_URL / SERVICE_ROLE_KEY ausentes'); process.exit(1) }
if (!ML_CLIENT_ID || !ML_CLIENT_SECRET) { console.error('[ml-cat] FATAL: ML_CLIENT_ID / ML_CLIENT_SECRET ausentes (refresh de token)'); process.exit(1) }

const args  = process.argv.slice(2)
const SITE  = (args.find(a => !a.startsWith('--')) ?? 'MLB').toUpperCase()
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity

const admin = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } })
const API   = 'https://api.mercadolibre.com'
const THROTTLE_MS = 60       // gentil com a API
const MAX_RETRY   = 4

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── Token ML ─────────────────────────────────────────────────────────────
// Categorias não são por-vendedor, então qualquer conexão válida serve. Pego
// a 1ª ml_connection, atualizo se estiver perto de expirar, e renovo no 401.
let TOKEN = null
let TOKEN_CONN = null

async function loadToken() {
  const { data: conn, error } = await admin
    .from('ml_connections')
    .select('organization_id, seller_id, access_token, refresh_token, expires_at')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !conn) throw new Error('nenhuma ml_connection disponível pra obter token')
  TOKEN_CONN = conn
  if (!conn.expires_at || new Date(conn.expires_at) <= new Date(Date.now() + 60_000)) {
    return await refreshToken()
  }
  TOKEN = conn.access_token
  return TOKEN
}

async function refreshToken() {
  const r = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: TOKEN_CONN.refresh_token,
    }),
  })
  if (!r.ok) throw new Error(`refresh token ${r.status}: ${await r.text()}`)
  const j = await r.json()
  await admin.from('ml_connections').update({
    access_token:  j.access_token,
    refresh_token: j.refresh_token,
    expires_at:    new Date(Date.now() + j.expires_in * 1000).toISOString(),
    updated_at:    new Date().toISOString(),
  }).eq('organization_id', TOKEN_CONN.organization_id).eq('seller_id', TOKEN_CONN.seller_id)
  TOKEN_CONN.refresh_token = j.refresh_token
  TOKEN = j.access_token
  console.log('[ml-cat] token renovado')
  return TOKEN
}

async function getJson(url) {
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15000)
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${TOKEN}` },
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (res.status === 401) {        // token expirou no meio do crawl
        console.warn('[ml-cat] 401 — renovando token')
        await refreshToken(); continue
      }
      if (res.status === 429 || res.status >= 500) {
        const wait = res.status === 429 ? 5000 : 1000 * (attempt + 1)
        console.warn(`[ml-cat] ${res.status} em ${url} — espera ${wait}ms (tentativa ${attempt + 1})`)
        await sleep(wait); continue
      }
      if (res.status === 404) return null
      if (!res.ok) { console.warn(`[ml-cat] HTTP ${res.status} em ${url} — pula`); return null }
      return await res.json()
    } catch (e) {
      clearTimeout(timer)
      const wait = 1000 * (attempt + 1)
      console.warn(`[ml-cat] erro ${url}: ${e.message} — espera ${wait}ms`)
      await sleep(wait)
    }
  }
  console.warn(`[ml-cat] desisti de ${url} após ${MAX_RETRY} tentativas`)
  return null
}

async function upsertBatch(rows) {
  if (rows.length === 0) return
  const { error } = await admin.from('ml_categories').upsert(rows, { onConflict: 'id' })
  if (error) console.error('[ml-cat] erro upsert batch:', error.message)
}

async function main() {
  console.log(`[ml-cat] crawl site=${SITE} limit=${LIMIT === Infinity ? 'todos' : LIMIT}`)
  const t0 = Date.now()

  await loadToken()
  console.log('[ml-cat] token carregado')

  // 1. raízes (domínios do site)
  const roots = await getJson(`${API}/sites/${SITE}/categories`)
  if (!Array.isArray(roots)) { console.error('[ml-cat] FATAL: não consegui as raízes'); process.exit(1) }
  console.log(`[ml-cat] ${roots.length} categorias raiz`)

  const queue   = roots.map(r => r.id)
  const visited = new Set()
  let batch = []
  let fetched = 0, leaves = 0

  while (queue.length > 0 && fetched < LIMIT) {
    const id = queue.shift()
    if (visited.has(id)) continue
    visited.add(id)

    const cat = await getJson(`${API}/categories/${encodeURIComponent(id)}`)
    await sleep(THROTTLE_MS)
    if (!cat || !cat.id) continue

    const pathFromRoot = Array.isArray(cat.path_from_root) ? cat.path_from_root : []
    const level    = Math.max(0, pathFromRoot.length - 1)
    const parentId = pathFromRoot.length >= 2 ? pathFromRoot[pathFromRoot.length - 2].id : null
    const children = Array.isArray(cat.children_categories) ? cat.children_categories : []
    const isLeaf   = children.length === 0
    if (isLeaf) leaves++

    batch.push({
      id:             cat.id,
      site_id:        SITE,
      parent_id:      parentId,
      name:           cat.name ?? '(sem nome)',
      path_from_root: pathFromRoot.map(p => ({ id: p.id, name: p.name })),
      level,
      is_leaf:        isLeaf,
      total_items:    typeof cat.total_items_in_this_category === 'number' ? cat.total_items_in_this_category : null,
      children_count: children.length,
      raw:            { settings: cat.settings ?? null },  // só o útil, evita inchar
      fetched_at:     new Date().toISOString(),
    })
    fetched++

    for (const ch of children) if (!visited.has(ch.id)) queue.push(ch.id)

    if (batch.length >= 400) { await upsertBatch(batch); batch = [] }
    if (fetched % 500 === 0) console.log(`[ml-cat] ${fetched} nós (${leaves} folhas, fila ${queue.length}) — ${Math.round((Date.now()-t0)/1000)}s`)
  }
  await upsertBatch(batch)

  console.log(`[ml-cat] PRONTO: ${fetched} nós (${leaves} folhas) em ${Math.round((Date.now()-t0)/1000)}s`)
}

main().catch(e => { console.error('[ml-cat] FATAL:', e); process.exit(1) })
