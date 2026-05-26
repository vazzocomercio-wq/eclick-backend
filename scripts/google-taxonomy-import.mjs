#!/usr/bin/env node
/**
 * Importa a Google Product Taxonomy → public.marketplace_categories (marketplace='meta').
 *
 * É a taxonomia que o catálogo Meta (Instagram/Facebook Shop) usa no campo
 * `google_product_category`. Arquivo PÚBLICO (sem token), ~5.500 categorias.
 *
 * ⚠️ SEGURO: só escreve em marketplace_categories. Não toca em products.
 *
 * Formato do arquivo (taxonomy-with-ids.<lang>.txt):
 *   # Google_Product_Taxonomy_Version: 2021-09-21
 *   1 - Animais e Pet Shop
 *   3237 - Animais e Pet Shop > Cuidados com Animais de Estimação
 *   ...
 * Cada linha = "<id> - <Cat> > <Sub> > <Folha>" (todo nível tem id próprio).
 *
 * Uso:
 *   node scripts/google-taxonomy-import.mjs            # pt-BR
 *   node scripts/google-taxonomy-import.mjs en-US
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA_URL = process.env.SUPABASE_URL
const SVC_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY
if (!SUPA_URL || !SVC_KEY) { console.error('[gtax] FATAL: SUPABASE_URL / SERVICE_ROLE_KEY ausentes'); process.exit(1) }

const LANG = process.argv[2] ?? 'pt-BR'
const URL  = `https://www.google.com/basepages/producttype/taxonomy-with-ids.${LANG}.txt`
const admin = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } })

async function main() {
  console.log(`[gtax] baixando ${URL}`)
  const res = await fetch(URL, { headers: { Accept: 'text/plain' } })
  if (!res.ok) { console.error(`[gtax] FATAL: HTTP ${res.status} ao baixar a taxonomia`); process.exit(1) }
  const text = await res.text()
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  console.log(`[gtax] ${lines.length} categorias`)

  // Parse: "<id> - <path com ' > '>"
  const nodes = []                 // { id, segments[], name, level }
  const pathToId = new Map()       // "A > B" -> id
  for (const line of lines) {
    const dash = line.indexOf(' - ')
    if (dash < 0) continue
    const id = line.slice(0, dash).trim()
    const fullPath = line.slice(dash + 3).trim()
    const segments = fullPath.split(' > ').map(s => s.trim())
    pathToId.set(fullPath, id)
    nodes.push({ id, segments, fullPath, name: segments[segments.length - 1], level: segments.length - 1 })
  }

  // parent_id + path_from_root (resolvendo o id de cada ancestral) + filhos (pra is_leaf)
  const hasChild = new Set()
  const rows = nodes.map(n => {
    const parentPath = n.segments.slice(0, -1).join(' > ')
    const parentId = parentPath ? (pathToId.get(parentPath) ?? null) : null
    if (parentId) hasChild.add(parentId)
    // path_from_root com ids resolvidos por prefixo
    const pathFromRoot = n.segments.map((_, i) => {
      const sub = n.segments.slice(0, i + 1).join(' > ')
      return { id: pathToId.get(sub) ?? null, name: n.segments[i] }
    })
    return { id: n.id, parent_id: parentId, name: n.name, full_path: n.fullPath, path_from_root: pathFromRoot, level: n.level }
  })
  for (const r of rows) r.is_leaf = !hasChild.has(r.id)

  // Upsert em lotes
  let done = 0
  const batchSize = 500
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize).map(r => ({
      marketplace:    'meta',
      external_id:    r.id,
      parent_id:      r.parent_id,
      name:           r.name,
      full_path:      r.full_path,
      path_from_root: r.path_from_root,
      level:          r.level,
      is_leaf:        r.is_leaf,
      fetched_at:     new Date().toISOString(),
    }))
    const { error } = await admin.from('marketplace_categories').upsert(batch, { onConflict: 'marketplace,external_id' })
    if (error) { console.error('[gtax] erro upsert:', error.message); process.exit(1) }
    done += batch.length
  }

  const folhas = rows.filter(r => r.is_leaf).length
  console.log(`[gtax] PRONTO: ${done} categorias meta (${folhas} folhas, lang ${LANG})`)
}

main().catch(e => { console.error('[gtax] FATAL:', e); process.exit(1) })
