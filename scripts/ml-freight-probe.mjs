#!/usr/bin/env node
/**
 * Diagnóstico read-only: dump do JSON cru de /shipments/{id}/costs do ML
 * para amostras de cada tipo logístico — descobrir bônus Flex, créditos e
 * descontos que o modelo atual (sender_cost) pode estar ignorando.
 *
 * Uso: node scripts/ml-freight-probe.mjs
 */
import { config } from 'node:process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { config as dotenv } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv({ path: path.resolve(here, '..', '.env') })

const SUPA = process.env.SUPABASE_URL
const KEY  = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
const ORG  = '4ef1aabd-c209-40b0-b034-ef69dcb66833'
const supa = createClient(SUPA, KEY)

// tokens por seller
const { data: conns } = await supa
  .from('ml_connections')
  .select('seller_id, access_token')
  .eq('organization_id', ORG)
const tokBySeller = new Map((conns || []).map(c => [String(c.seller_id), c.access_token]))

// amostras: pega até 4 shipping por logistic_type (foco no Flex)
const { data: orders } = await supa
  .from('orders')
  .select('external_order_id, shipping_id, seller_id, sale_price, quantity, shipping_cost, raw_data')
  .eq('organization_id', ORG).eq('platform', 'mercadolivre')
  .neq('status', 'cancelled')
  .not('shipping_id', 'is', null)
  .gte('sold_at', '2026-04-01')
  .order('sold_at', { ascending: false })
  .limit(2000)

const byType = new Map()
for (const o of orders || []) {
  const lt = o.raw_data?.shipping?.logistic_type || '(sem)'
  if (!byType.has(lt)) byType.set(lt, [])
  const arr = byType.get(lt)
  const cap = lt === 'self_service' ? 5 : 2
  if (arr.length < cap) arr.push(o)
}

for (const [lt, arr] of byType) {
  console.log(`\n========== ${lt} (${arr.length} amostras) ==========`)
  for (const o of arr) {
    const tok = tokBySeller.get(String(o.seller_id))
    if (!tok) { console.log(`  ${o.shipping_id}: sem token p/ seller ${o.seller_id}`); continue }
    try {
      const r = await fetch(`https://api.mercadolibre.com/shipments/${o.shipping_id}/costs`, {
        headers: { Authorization: `Bearer ${tok}` },
      })
      const j = await r.json()
      console.log(`\n  --- ship ${o.shipping_id} | order ${o.external_order_id} | venda R$${o.sale_price}x${o.quantity} | shipping_cost gravado R$${o.shipping_cost} ---`)
      console.log('  ' + JSON.stringify(j, null, 2).split('\n').join('\n  '))
    } catch (e) {
      console.log(`  ${o.shipping_id}: ERRO ${e.message}`)
    }
    await new Promise(res => setTimeout(res, 200))
  }
}
