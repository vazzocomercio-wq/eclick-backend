// Auditoria completa Shopee: escrow real de TODOS os pedidos entregues.
// railway run node scripts/shopee-escrow-full.mjs
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'

const PARTNER_ID  = process.env.SHOPEE_PARTNER_ID
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY
const SUPA_URL    = process.env.SUPABASE_URL
const SUPA_KEY    = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
const BASE = 'https://openplatform.shopee.com.br'
const ORG  = '4ef1aabd-c209-40b0-b034-ef69dcb66833'
if (!PARTNER_ID || !PARTNER_KEY) { console.error('FALTAM SHOPEE creds'); process.exit(1) }

const supa = createClient(SUPA_URL, SUPA_KEY)
const sign = (path, ts, token, shopId) =>
  crypto.createHmac('sha256', PARTNER_KEY).update(`${PARTNER_ID}${path}${ts}${token}${shopId}`).digest('hex')

const { data: conn } = await supa.from('marketplace_connections')
  .select('access_token, shop_id').eq('organization_id', ORG).eq('platform', 'shopee').eq('status', 'connected').limit(1).maybeSingle()
if (!conn) { console.error('sem conexão shopee'); process.exit(1) }
const { access_token, shop_id } = conn

const { data: orders } = await supa.from('orders')
  .select('external_order_id').eq('organization_id', ORG).eq('source', 'shopee').eq('status', 'delivered')
  .order('sold_at', { ascending: false }).limit(1000)
const sns = [...new Set((orders || []).map(o => o.external_order_id))]
console.log('pedidos entregues p/ escrow:', sns.length)

const path = '/api/v2/payment/get_escrow_detail'
const agg = { n:0, price:0, commission:0, service:0, txn:0, escrow:0, buyerPaid:0, actualShip:0, discounts:0 }
const bands = {} // faixa -> {n, price, fees}
let errors = 0

for (const sn of sns) {
  const ts = Math.floor(Date.now() / 1000)
  const s = sign(path, ts, access_token, shop_id)
  const qs = new URLSearchParams({ partner_id: PARTNER_ID, timestamp: String(ts), access_token, shop_id: String(shop_id), sign: s, order_sn: sn })
  let j
  for (let a=0; a<4; a++) {
    try { const r = await fetch(`${BASE}${path}?${qs}`); j = await r.json() } catch { j = null }
    if (j && !j.error) break
    if (j?.error?.includes?.('rate')) { await new Promise(r=>setTimeout(r,1500)); continue }
    break
  }
  if (!j || j.error) { errors++; continue }
  const inc = j.response?.order_income || {}
  const price      = Number(inc.order_selling_price ?? inc.merchant_subtotal ?? inc.original_price ?? 0)
  const commission = Number(inc.commission_fee ?? 0)
  const service    = Number(inc.service_fee ?? 0)
  const txn        = Number(inc.seller_transaction_fee ?? 0)
  const escrow     = Number(inc.escrow_amount ?? 0)
  const actualShip = Number(inc.actual_shipping_fee ?? 0)
  if (price <= 0) { errors++; continue }
  agg.n++; agg.price += price; agg.commission += commission; agg.service += service
  agg.txn += txn; agg.escrow += escrow; agg.actualShip += actualShip
  agg.discounts += Math.max(0, price - escrow - commission - service - txn)
  const b = price < 50 ? 'a) <R$50' : price < 150 ? 'b) R$50-150' : price < 300 ? 'c) R$150-300' : 'd) >R$300'
  if (!bands[b]) bands[b] = { n:0, price:0, fees:0, net:0 }
  bands[b].n++; bands[b].price += price; bands[b].fees += (price - escrow); bands[b].net += escrow
  await new Promise(r => setTimeout(r, 120))
}

const pct = (x) => agg.price > 0 ? (x / agg.price * 100).toFixed(2) + '%' : 'n/a'
console.log('\n=== AGREGADO REAL SHOPEE (escrow) ===')
console.log('pedidos com escrow:', agg.n, '| erros:', errors)
console.log('venda total       R$', agg.price.toFixed(2))
console.log('comissão          R$', agg.commission.toFixed(2), pct(agg.commission))
console.log('taxa de serviço   R$', agg.service.toFixed(2), pct(agg.service))
console.log('taxa transação    R$', agg.txn.toFixed(2), pct(agg.txn))
console.log('PIX/cupom/outros  R$', agg.discounts.toFixed(2), pct(agg.discounts))
console.log('frete real (info) R$', agg.actualShip.toFixed(2), pct(agg.actualShip))
const totalTake = agg.price - agg.escrow
console.log('>>> VOCÊ RECEBEU   R$', agg.escrow.toFixed(2), pct(agg.escrow))
console.log('>>> TAKE TOTAL REAL:', pct(totalTake), '(comissão+serviço+txn+pix/cupom)')
console.log('\n=== POR FAIXA DE TICKET ===')
for (const [b, v] of Object.entries(bands).sort()) {
  console.log(b.padEnd(14), 'n='+String(v.n).padStart(4), 'venda R$'+v.price.toFixed(0).padStart(8), 'take', (v.fees/v.price*100).toFixed(1)+'%')
}
