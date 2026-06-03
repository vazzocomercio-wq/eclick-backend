#!/usr/bin/env node
/** Read-only: agrega TODAS as linhas da fatura ML de um período por tipo de
 *  cobrança (detail_sub_type) — a quebra real do que o ML consome. */
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

const agg = {} // sellerScoped totals merged: subtype -> {label, type, sum, n}
let grandSum = 0, grandN = 0
let gmvFromBilling = 0
const seenOrders = new Set()

for (const { seller_id, access_token: tok } of conns) {
  let offset = 0, total = Infinity, pages = 0
  const LIMIT = 1000
  while (offset < total && pages < 50) {
    const url = `https://api.mercadolibre.com/billing/integration/periods/key/${KEY}/group/ML/details?document_type=BILL&offset=${offset}&limit=${LIMIT}`
    let r, j
    for (let attempt = 0; attempt < 5; attempt++) {
      r = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, 'x-version': '2' } })
      if (r.status === 429) { await new Promise(s => setTimeout(s, 2500)); continue }
      break
    }
    try { j = await r.json() } catch { j = null }
    if (!j || !Array.isArray(j.results)) { console.error(`seller ${seller_id} HTTP ${r?.status} offset ${offset}`); break }
    total = j.total ?? 0
    for (const row of j.results) {
      const ci = row.charge_info || {}
      const st = ci.detail_sub_type || '(null)'
      const lbl = ci.transaction_detail || st
      const ty = ci.detail_type || '?'
      const amt = Number(ci.detail_amount || 0)
      const k = `${ty}|${st}`
      if (!agg[k]) agg[k] = { label: lbl, type: ty, subtype: st, sum: 0, n: 0 }
      agg[k].sum += amt; agg[k].n++
      grandSum += amt; grandN++
      const si = (row.sales_info || [])[0]
      if (si?.order_id && !seenOrders.has(si.order_id)) { seenOrders.add(si.order_id); gmvFromBilling += Number(si.transaction_amount || 0) }
    }
    offset += LIMIT; pages++
    await new Promise(s => setTimeout(s, 1200))
  }
  console.error(`seller ${seller_id}: ${total} linhas lidas`)
}

// sinal: BONUS = crédito (negativo). Bucket por categoria de negócio.
const CAT = {
  CVVML:'Comissão', CV:'Comissão', BVVML:'Comissão', BV:'Comissão',
  CVVPRC:'Cobrança/Recebimento (MP)', CVVFNU:'Cobrança/Recebimento (MP)', BVVPRC:'Cobrança/Recebimento (MP)', BVVFNU:'Cobrança/Recebimento (MP)',
  CFONPN:'Parcelamento', CVVFN:'Parcelamento', BFONPN:'Parcelamento', BVVFN:'Parcelamento',
  CXDE:'Frete/Envios', CDSB:'Frete/Envios', CXDI:'Frete/Envios', CDSDB:'Frete/Envios', CXDED:'Frete/Envios', CPYE:'Frete/Envios',
  BXDE:'Frete/Envios', BDSB:'Frete/Envios', BXDI:'Frete/Envios', BDSDB:'Frete/Envios', BXDED:'Frete/Envios', BPYE:'Frete/Envios',
  PADS:'Publicidade (Ads)', CDLIT:'Publicidade (Ads)', BPAD:'Publicidade (Ads)',
  CSTP:'Outros', CESM:'Outros', CDIFAL:'Impostos (DIFAL)',
}
const signed = (r) => r.type === 'BONUS' ? -r.sum : r.sum
const cats = {}
let net = 0
for (const r of Object.values(agg)) {
  const c = CAT[r.subtype] || 'Outros'
  const v = signed(r)
  cats[c] = (cats[c] || 0) + v
  net += v
}
const rows = Object.values(agg).sort((a, b) => Math.abs(signed(b)) - Math.abs(signed(a)))
console.log(`\n=== FATURA ML ${KEY} — linhas por tipo (BONUS=crédito) ===`)
for (const r of rows) console.log(r.subtype.padEnd(8), r.type.padEnd(7), String(r.n).padStart(5), signed(r).toFixed(2).padStart(12), '  ' + r.label)

const gmv = gmvFromBilling
console.log(`\n=== RESUMO POR CATEGORIA (GMV R$${gmv.toFixed(0)}, ${seenOrders.size} pedidos) ===`)
for (const [c, v] of Object.entries(cats).sort((a,b)=>b[1]-a[1])) {
  console.log(c.padEnd(28), ('R$'+v.toFixed(2)).padStart(13), (gmv>0?(v/gmv*100).toFixed(2)+'%':'').padStart(8))
}
const ads = cats['Publicidade (Ads)']||0
console.log('-'.repeat(52))
console.log('NET TOTAL (tudo)'.padEnd(28), ('R$'+net.toFixed(2)).padStart(13), (net/gmv*100).toFixed(2).padStart(7)+'%')
console.log('NET sem Ads (taxas puras)'.padEnd(28), ('R$'+(net-ads).toFixed(2)).padStart(13), ((net-ads)/gmv*100).toFixed(2).padStart(7)+'%')
