#!/usr/bin/env node
/** Investiga as taxas de parcelamento (CFONPN/CVVFN) da fatura ML:
 *  quais pedidos, valor, e cruza com installments/payment do pedido. */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { config as dotenv } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv({ path: path.resolve(here, '..', '.env') })
const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY)
const ORG = '4ef1aabd-c209-40b0-b034-ef69dcb66833'
const KEY = process.argv[2] || '2026-05-01'
const { data: conns } = await supa.from('ml_connections').select('seller_id, access_token').eq('organization_id', ORG)

const lines = [] // {sub, amount, order_id, txn, financing_fee, financing_transfer_total, sale_date}
for (const { seller_id, access_token: tok } of conns) {
  let offset = 0, total = Infinity, pages = 0
  while (offset < total && pages < 50) {
    const url = `https://api.mercadolibre.com/billing/integration/periods/key/${KEY}/group/ML/details?document_type=BILL&offset=${offset}&limit=1000`
    let r, j
    for (let a=0;a<5;a++){ r=await fetch(url,{headers:{Authorization:`Bearer ${tok}`,'x-version':'2'}}); if(r.status===429){await new Promise(s=>setTimeout(s,2500));continue} break }
    try { j = await r.json() } catch { j = null }
    if (!j?.results) break
    total = j.total ?? 0
    for (const row of j.results) {
      const st = row.charge_info?.detail_sub_type
      if (st !== 'CFONPN' && st !== 'CVVFN' && st !== 'BFONPN' && st !== 'BVVFN') continue
      const si = (row.sales_info || [])[0] || {}
      lines.push({
        sub: st, type: row.charge_info?.detail_type, amount: Number(row.charge_info?.detail_amount||0),
        order_id: si.order_id, txn: Number(si.transaction_amount||0),
        financing_fee: si.financing_fee, financing_transfer_total: si.financing_transfer_total,
        sale_date: si.sale_date_time,
      })
    }
    offset += 1000; pages++
    await new Promise(s=>setTimeout(s,1200))
  }
}

console.log(`linhas de parcelamento em ${KEY}:`, lines.length)
const charges = lines.filter(l => l.type === 'CHARGE')
console.log('exemplos (CHARGE):')
for (const l of charges.slice(0, 12)) {
  console.log(`  ${l.sub} R$${l.amount.toFixed(2)} | pedido ${l.order_id} venda R$${l.txn} | financing_fee=${l.financing_fee} transfer=${l.financing_transfer_total}`)
}

// cruza com installments do pedido
const orderIds = [...new Set(charges.map(l => String(l.order_id)).filter(Boolean))].slice(0, 200)
const { data: ords } = await supa.from('orders')
  .select('external_order_id, raw_data').eq('organization_id', ORG).in('external_order_id', orderIds)
const instById = new Map()
for (const o of ords || []) {
  const p = (o.raw_data?.payments || [])[0] || {}
  instById.set(o.external_order_id, { installments: p.installments, method: p.payment_method_id, type: p.payment_type })
}
const dist = {}
for (const l of charges) {
  const inf = instById.get(String(l.order_id))
  const k = inf ? `${inf.installments}x ${inf.method}` : '(sem pedido no DB)'
  if (!dist[k]) dist[k] = { n:0, sum:0 }
  dist[k].n++; dist[k].sum += l.amount
}
console.log('\n=== distribuição por nº de parcelas (método pgto) ===')
for (const [k,v] of Object.entries(dist).sort((a,b)=>b[1].sum-a[1].sum)) {
  console.log('  ', k.padEnd(28), 'n='+String(v.n).padStart(4), 'R$'+v.sum.toFixed(2))
}
const totCharge = charges.reduce((s,l)=>s+l.amount,0)
const totBonus = lines.filter(l=>l.type==='BONUS').reduce((s,l)=>s+l.amount,0)
console.log('\ntotal cobrado parcelamento R$', totCharge.toFixed(2), '| cancelado R$', totBonus.toFixed(2), '| net R$', (totCharge-totBonus).toFixed(2))
