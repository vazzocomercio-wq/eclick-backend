#!/usr/bin/env node
/**
 * Backfill de product_listings.account_id nos anúncios ML sem dono registrado.
 *
 * Contexto: quando o vínculo não sabe de qual conta ML é o anúncio, todo push
 * de estoque precisa varrer TODAS as contas da org até uma aceitar (fan-out).
 * Isso é lento e — antes do fix do Promise.allSettled — bastava uma conta com
 * refresh quebrado pra derrubar a atualização (e a PAUSA) desses anúncios.
 * Descobrir o dono uma vez e gravar elimina o fan-out.
 *
 * O `syncToMl` já grava o account_id quando o push dá certo; este script
 * antecipa isso sem depender de um ciclo de sync bem-sucedido.
 *
 * Uso:
 *   node scripts/backfill-ml-account-id.mjs            # dry-run (só mostra)
 *   node scripts/backfill-ml-account-id.mjs --apply    # grava
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.join(__dirname, '..', '.env') })

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY
const APPLY        = process.argv.includes('--apply')

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no .env')
  process.exit(1)
}

const sb = (p, init = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${p}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })

async function main() {
  // 1. Vínculos ML ativos sem account_id, com a org do produto.
  const res = await sb('product_listings?select=id,listing_id,product_id,products(organization_id)&platform=eq.mercadolivre&is_active=is.true&account_id=is.null')
  const alvos = await res.json()
  if (!Array.isArray(alvos) || alvos.length === 0) {
    console.log('Nada a fazer — todos os anúncios ML já têm conta registrada.')
    return
  }
  console.log(`${alvos.length} anúncio(s) ML sem conta registrada.${APPLY ? '' : '  (dry-run — use --apply pra gravar)'}`)

  // 2. Tokens por org (uma vez só).
  const tokensPorOrg = new Map()
  const tokensFor = async (orgId) => {
    if (tokensPorOrg.has(orgId)) return tokensPorOrg.get(orgId)
    const r = await sb(`ml_connections?select=seller_id,access_token&organization_id=eq.${orgId}`)
    const conns = await r.json()
    const list = Array.isArray(conns) ? conns : []
    tokensPorOrg.set(orgId, list)
    return list
  }

  let achados = 0, gravados = 0, semDono = 0
  for (const l of alvos) {
    const orgId = l.products?.organization_id
    if (!orgId) { console.log(`  ${l.listing_id}: produto sem organização — pulado`); continue }
    const conns = await tokensFor(orgId)

    let dono = null
    for (const c of conns) {
      const r = await fetch(`https://api.mercadolibre.com/items/${l.listing_id}?attributes=id,seller_id,status`, {
        headers: { Authorization: `Bearer ${c.access_token}` },
      })
      if (!r.ok) continue
      const j = await r.json().catch(() => null)
      if (j?.id) { dono = j.seller_id ?? c.seller_id; break }
    }

    if (!dono) { semDono++; console.log(`  ${l.listing_id}: nenhuma conta da org enxerga o anúncio`); continue }
    achados++
    console.log(`  ${l.listing_id} → conta ${dono}`)

    if (APPLY) {
      const up = await sb(`product_listings?id=eq.${l.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ account_id: String(dono) }),
      })
      if (up.ok) gravados++
      else console.log(`     falhou ao gravar: ${up.status} ${await up.text()}`)
    }
  }

  console.log(`\nDono identificado: ${achados} · gravados: ${gravados} · sem dono: ${semDono}`)
}

main().catch(e => { console.error(e); process.exit(1) })
