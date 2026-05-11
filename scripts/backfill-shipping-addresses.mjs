#!/usr/bin/env node
/**
 * Backfill receiver_address em raw_data.shipping pra pedidos novos.
 *
 * Contexto: ML retorna `shipping: {id}` apenas em /orders/{id} — o
 * endereço completo (state/city/zip) só vem em /shipments/{id}. Como
 * o webhook orders_v2 chama /orders/{id}, pedidos novos chegam ao DB
 * sem o endereço — e o mapa "Vendas por Região" do dashboard fica
 * zerado.
 *
 * Esse script roda offline (sem precisar do backend) batendo direto
 * em ML + Supabase via service_role.
 *
 * Uso:
 *   node scripts/backfill-shipping-addresses.mjs            # 30 dias, todas as orgs
 *   node scripts/backfill-shipping-addresses.mjs 60         # 60 dias
 *   node scripts/backfill-shipping-addresses.mjs 30 <orgId> # 30 dias, org específica
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA_URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPA_URL || !KEY) {
  console.error('[backfill-address] env SUPABASE_URL ou SUPABASE_SECRET_KEY/SERVICE_ROLE_KEY ausente')
  process.exit(1)
}

const daysBack = Number(process.argv[2] ?? 30)
const orgFilter = process.argv[3] ?? null

const SUPA_BASE = SUPA_URL.replace(/\/+$/, '')
const HEADERS = { 'apikey': KEY, 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' }

const sql = async (statement) => {
  const r = await fetch(`${SUPA_BASE}/rest/v1/rpc/_admin_query_sql`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ sql: statement }),
  })
  const body = await r.json().catch(() => null)
  if (!r.ok || (body && body.error)) {
    throw new Error(`SQL falhou (${r.status}): ${body?.error ?? JSON.stringify(body)}`)
  }
  return body
}

const exec = async (statement) => {
  const r = await fetch(`${SUPA_BASE}/rest/v1/rpc/_admin_exec_sql`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ sql: statement }),
  })
  const body = await r.text().catch(() => '')
  if (!r.ok) {
    throw new Error(`exec falhou (${r.status}): ${body}`)
  }
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms))
const esc = (s) => String(s).replace(/'/g, "''")

console.log(`[backfill-address] daysBack=${daysBack} org=${orgFilter ?? 'todas'}`)

// 1. Seleciona pedidos sem receiver_address
const orgClause = orgFilter ? `AND organization_id = '${esc(orgFilter)}'::uuid` : ''
// Filtro pega 3 casos: (1) SQL null, (2) JSON null explícito, (3) ausente.
// Bug catch: `->'receiver_address' IS NULL` NÃO match JSON null (só SQL null),
// e `->>'receiver_address' = 'null'` NÃO match porque ->> de JSON null já é
// SQL null. Único jeito robusto é comparar com 'null'::jsonb.
const selectSql = `
  SELECT id, organization_id, seller_id, shipping_id, external_order_id, raw_data
  FROM orders
  WHERE source = 'mercadolivre'
    AND shipping_id IS NOT NULL
    AND (raw_data->'shipping'->'receiver_address' IS NULL
         OR raw_data->'shipping'->'receiver_address' = 'null'::jsonb
         OR raw_data->'shipping'->'receiver_address'->>'state' IS NULL)
    AND sold_at >= NOW() - INTERVAL '${daysBack} days'
    AND status <> 'cancelled'
    ${orgClause}
  ORDER BY sold_at DESC
  LIMIT 1000
`
const rows = await sql(selectSql)
console.log(`[backfill-address] selecionou ${rows.length} pedidos sem endereço`)

if (rows.length === 0) {
  console.log('[backfill-address] nada a fazer — bye')
  process.exit(0)
}

// 2. Agrupa por (organization_id, seller_id) pra buscar token correto
const groups = new Map()
for (const r of rows) {
  const k = `${r.organization_id}::${r.seller_id}`
  if (!groups.has(k)) groups.set(k, { orgId: r.organization_id, sellerId: r.seller_id, items: [] })
  groups.get(k).items.push(r)
}

let updated = 0
let skipped = 0
let checked = 0

for (const { orgId, sellerId, items } of groups.values()) {
  // 2a. Pega token mais recente válido pra essa conta
  const tokenRows = await sql(`
    SELECT access_token
    FROM ml_connections
    WHERE organization_id = '${esc(orgId)}'::uuid
      AND seller_id = ${sellerId}
    ORDER BY updated_at DESC
    LIMIT 1
  `)
  const token = tokenRows[0]?.access_token
  if (!token) {
    console.warn(`[backfill-address] org=${orgId.slice(0,8)} seller=${sellerId} sem token — pulando ${items.length}`)
    skipped += items.length
    continue
  }

  console.log(`[backfill-address] org=${orgId.slice(0,8)} seller=${sellerId} processando ${items.length} pedidos`)

  for (const row of items) {
    checked++
    try {
      // NÃO usar x-format-new: true — esse header omite receiver_address
      // do payload. O formato legado tem endereço + status/substatus/logistic_type.
      const r = await fetch(`https://api.mercadolibre.com/shipments/${row.shipping_id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) {
        console.warn(`[backfill-address] /shipments/${row.shipping_id} HTTP ${r.status}`)
        skipped++
        await sleep(200)
        continue
      }
      const ship = await r.json()
      const recv = ship?.receiver_address
      if (!recv) {
        skipped++
        await sleep(200)
        continue
      }

      // Mescla os campos no raw_data.shipping
      const raw = row.raw_data ?? {}
      const existing = raw.shipping ?? {}
      const newRaw = {
        ...raw,
        shipping: {
          ...existing,
          status:           ship.status        ?? existing.status        ?? null,
          substatus:        ship.substatus     ?? existing.substatus     ?? null,
          logistic_type:    ship.logistic_type ?? existing.logistic_type ?? null,
          receiver_address: recv,
          estimated_delivery_date: ship.estimated_delivery_date ?? ship.shipping_option?.estimated_delivery_final?.date ?? existing.estimated_delivery_date ?? null,
          posting_deadline:        ship.posting_deadline        ?? ship.shipping_option?.estimated_handling_limit?.date ?? existing.posting_deadline ?? null,
          date_created:            ship.date_created            ?? existing.date_created            ?? null,
        },
      }

      const newRawJson = esc(JSON.stringify(newRaw))
      const setStatus = ship.status ? `, shipping_status = '${esc(ship.status)}'` : ''
      await exec(`
        UPDATE orders
        SET raw_data = '${newRawJson}'::jsonb
            ${setStatus},
            updated_at = NOW()
        WHERE id = '${esc(row.id)}'::uuid
      `)
      updated++
    } catch (err) {
      console.warn(`[backfill-address] erro em order=${row.external_order_id}: ${err.message}`)
      skipped++
    }
    // Pacing pra evitar 429 do ML (~5 req/s por token)
    await sleep(220)
  }
}

console.log(`[backfill-address] FIM checked=${checked} updated=${updated} skipped=${skipped}`)
