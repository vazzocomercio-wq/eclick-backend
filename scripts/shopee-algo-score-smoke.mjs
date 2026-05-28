#!/usr/bin/env node
/**
 * Smoke test do ShopeeAlgoScoreService — fixtures sintéticas, sem
 * dependência de creds Shopee ou DB. Valida que as fórmulas dos 4 pilares
 * batem com cenários conhecidos (anúncio ouro / médio / ruim).
 *
 * Uso: node scripts/shopee-algo-score-smoke.mjs
 *
 * Re-implementa a fórmula em JS puro (pra rodar sem build TS). Quando
 * F1.2 (Listing Center UI) plugar, esse script vira referência de QA.
 */

// ─── Re-implementa compute() em JS puro (espelho do service TS) ────────────

const PILLAR_WEIGHTS = {
  relevance:        0.40,
  performance:      0.30,
  seller_quality:   0.20,
  price_marketing:  0.10,
}

function clamp(v) { return Math.max(0, Math.min(100, Math.round(v))) }

function scoreRelevance(i) {
  const subs = []
  const title = i.title ?? ''
  let t
  if (!title)               t = 0
  else if (title.length < 30)  t = Math.round((title.length / 30) * 60)
  else if (title.length < 60)  t = 70
  else if (title.length <= 120) t = 100
  else t = 60
  subs.push(t * 0.30)

  let a
  const tm = i.attrs_mandatory_total, fl = i.attrs_filled
  if (tm == null || fl == null) a = 50
  else if (tm === 0)            a = 100
  else                          a = Math.round((fl / tm) * 100)
  subs.push(a * 0.30)

  const c = i.image_count ?? 0, d = i.image_min_dimension ?? 0
  let cs
  if (c === 0)      cs = 0
  else if (c < 3)   cs = 30
  else if (c < 5)   cs = 70
  else              cs = 100
  let ds
  if (d === 0)       ds = 50
  else if (d < 500)  ds = 30
  else if (d < 1000) ds = 70
  else               ds = 100
  subs.push(Math.round(cs * 0.5 + ds * 0.5) * 0.20)

  const desc = i.description ?? ''
  let ds2
  if (!desc)               ds2 = 0
  else if (desc.length < 200) ds2 = 30
  else if (desc.length < 500) ds2 = 70
  else                        ds2 = 100
  subs.push(ds2 * 0.20)

  return clamp(subs.reduce((a, b) => a + b, 0))
}

function scorePerformance(i) {
  const subs = []
  const s7 = i.sales_7d ?? null
  let ss
  if (s7 == null)    ss = 50
  else if (s7 >= 10) ss = 100
  else if (s7 >= 5)  ss = 80
  else if (s7 >= 1)  ss = 40 + s7 * 8
  else               ss = 10
  subs.push(ss * 0.35)

  const ctr = i.ctr ?? null
  let cs
  if (ctr == null)        cs = 50
  else if (ctr >= 0.03)   cs = 100
  else if (ctr >= 0.01)   cs = Math.round(50 + ((ctr - 0.01) / 0.02) * 50)
  else if (ctr >= 0.005)  cs = Math.round(((ctr - 0.005) / 0.005) * 50)
  else                    cs = 0
  subs.push(cs * 0.25)

  const cv = i.conversion ?? null
  let cvs
  if (cv == null)        cvs = 50
  else if (cv >= 0.05)   cvs = 100
  else if (cv >= 0.02)   cvs = Math.round(60 + ((cv - 0.02) / 0.03) * 40)
  else if (cv >= 0.005)  cvs = Math.round(((cv - 0.005) / 0.015) * 60)
  else                   cvs = 0
  subs.push(cvs * 0.30)

  const ca = i.created_at ? new Date(i.created_at) : null
  let ns
  if (!ca) ns = 50
  else {
    const days = (Date.now() - ca.getTime()) / 86400_000
    if (days < 30)       ns = 100
    else if (days < 90)  ns = 60
    else if (days < 180) ns = 30
    else                 ns = 0
  }
  subs.push(ns * 0.10)
  return clamp(subs.reduce((a, b) => a + b, 0))
}

function scoreSellerQuality(i) {
  if (!i.shop_metrics) return 50
  const m = i.shop_metrics
  const subs = []

  const r = m.chat_response_rate, t = m.chat_response_time_min
  let cs
  if (r == null && t == null) cs = 50
  else {
    const rs = r == null ? 50 : Math.round(r * 100)
    let ts
    if (t == null)      ts = 50
    else if (t <= 5)    ts = 100
    else if (t <= 15)   ts = 80
    else if (t <= 60)   ts = 50
    else if (t <= 240)  ts = 25
    else                ts = 0
    cs = Math.round(rs * 0.6 + ts * 0.4)
  }
  subs.push(cs * 0.20)

  const p = m.prep_time_days, l = m.late_ship_rate
  let ss
  if (p == null && l == null) ss = 50
  else {
    let ps
    if (p == null)    ps = 50
    else if (p <= 1)  ps = 100
    else if (p <= 2)  ps = 70
    else if (p <= 3)  ps = 40
    else              ps = 10
    let ls
    if (l == null)       ls = 50
    else if (l <= 0.01)  ls = 100
    else if (l <= 0.05)  ls = 70
    else if (l <= 0.10)  ls = 40
    else                 ls = 0
    ss = Math.round(ps * 0.5 + ls * 0.5)
  }
  subs.push(ss * 0.25)

  const ret = m.return_refund_rate
  let rs
  if (ret == null)      rs = 50
  else if (ret <= 0.02) rs = 100
  else if (ret <= 0.05) rs = 70
  else if (ret <= 0.10) rs = 30
  else                  rs = 0
  subs.push(rs * 0.20)

  const rt = m.rating
  let rts
  if (rt == null)     rts = 50
  else if (rt >= 4.8) rts = 100
  else if (rt >= 4.5) rts = 80
  else if (rt >= 4.0) rts = 50
  else                rts = 0
  subs.push(rts * 0.20)

  const pen = m.penalty_points
  let ps
  if (pen == null)    ps = 100
  else if (pen === 0) ps = 100
  else if (pen <= 2)  ps = 70
  else if (pen <= 5)  ps = 30
  else                ps = 0
  subs.push(ps * 0.15)

  return clamp(subs.reduce((a, b) => a + b, 0))
}

function scorePriceMarketing(i) {
  const subs = []
  const pr = i.price, md = i.market_median_price
  let ps
  if (pr == null || md == null || md <= 0) ps = 50
  else {
    const ratio = pr / md
    if (ratio <= 0.90)      ps = 100
    else if (ratio <= 1.05) ps = 80
    else if (ratio <= 1.10) ps = 50
    else                    ps = 10
  }
  subs.push(ps * 0.60)

  let slots = 0
  if (i.has_voucher)    slots++
  if (i.has_flash_sale) slots++
  if (i.has_ads)        slots++
  const ms = slots === 0 ? 20 : Math.round((slots / 3) * 100)
  subs.push(ms * 0.40)

  return clamp(subs.reduce((a, b) => a + b, 0))
}

function compute(input) {
  const r = scoreRelevance(input)
  const p = scorePerformance(input)
  const q = scoreSellerQuality(input)
  const pm = scorePriceMarketing(input)
  const score = Math.round(
    PILLAR_WEIGHTS.relevance       * r +
    PILLAR_WEIGHTS.performance     * p +
    PILLAR_WEIGHTS.seller_quality  * q +
    PILLAR_WEIGHTS.price_marketing * pm,
  )
  return { score, pillars: { relevance: r, performance: p, seller_quality: q, price_marketing: pm } }
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const GOLD = {
  shop_id: 1, item_id: 100,
  title: 'Arandela LED Cristal K9 Dourada 5W Quente Sala Quarto Decoração Premium',
  description: '• 5 anos de garantia\n• Cristal K9 lapidado a mão\n• LED 3000K luz quente\n• Dimensões: 15x15x20cm\n• Voltagem bivolt\n• Acompanha kit instalação\n• Frete grátis SP\n• Pronta entrega'.repeat(2),
  image_count: 7, image_min_dimension: 1200,
  attrs_filled: 12, attrs_mandatory_total: 12,
  sales_7d: 14, ctr: 0.045, conversion: 0.08,
  created_at: new Date(Date.now() - 14 * 86400_000),
  shop_metrics: {
    chat_response_rate: 0.96, chat_response_time_min: 4,
    prep_time_days: 0.8, late_ship_rate: 0.005,
    return_refund_rate: 0.015, rating: 4.9, penalty_points: 0,
  },
  price: 89.90, market_median_price: 99.90,
  has_voucher: true, has_flash_sale: false, has_ads: true,
}

const MED = {
  shop_id: 1, item_id: 200,
  title: 'Arandela LED Dourada',
  description: 'Arandela LED dourada para sala. Bivolt.',
  image_count: 3, image_min_dimension: 700,
  attrs_filled: 6, attrs_mandatory_total: 12,
  sales_7d: 3, ctr: 0.015, conversion: 0.025,
  created_at: new Date(Date.now() - 60 * 86400_000),
  shop_metrics: {
    chat_response_rate: 0.82, chat_response_time_min: 35,
    prep_time_days: 2.2, late_ship_rate: 0.04,
    return_refund_rate: 0.04, rating: 4.5, penalty_points: 1,
  },
  price: 105.00, market_median_price: 99.90,
  has_voucher: false, has_flash_sale: false, has_ads: false,
}

const BAD = {
  shop_id: 1, item_id: 300,
  title: 'Arandela',
  description: 'Arandela.',
  image_count: 1, image_min_dimension: 400,
  attrs_filled: 2, attrs_mandatory_total: 12,
  sales_7d: 0, ctr: 0.002, conversion: 0.003,
  created_at: new Date(Date.now() - 240 * 86400_000),
  shop_metrics: {
    chat_response_rate: 0.55, chat_response_time_min: 500,
    prep_time_days: 4.5, late_ship_rate: 0.18,
    return_refund_rate: 0.14, rating: 3.6, penalty_points: 7,
  },
  price: 130.00, market_median_price: 99.90,
  has_voucher: false, has_flash_sale: false, has_ads: false,
}

const cases = [
  { name: 'GOLD (ouro)',  fixture: GOLD, expect: 'score >= 85' },
  { name: 'MED (médio)',  fixture: MED,  expect: '40 <= score <= 65' },
  { name: 'BAD (ruim)',   fixture: BAD,  expect: 'score <= 20' },
]

console.log('Shopee Algorithm Score — smoke fixtures\n')
console.log('═'.repeat(70))

let allOk = true
for (const c of cases) {
  const r = compute(c.fixture)
  let ok = false
  if (c.name.startsWith('GOLD')) ok = r.score >= 85
  else if (c.name.startsWith('MED')) ok = r.score >= 40 && r.score <= 65
  else if (c.name.startsWith('BAD')) ok = r.score <= 20
  if (!ok) allOk = false
  console.log(`\n${ok ? '✓' : '✗'} ${c.name} → score=${r.score} (esperado: ${c.expect})`)
  console.log(`  Relevance:       ${String(r.pillars.relevance).padStart(3)}  × 0.40 = ${(r.pillars.relevance * 0.40).toFixed(1)}`)
  console.log(`  Performance:     ${String(r.pillars.performance).padStart(3)}  × 0.30 = ${(r.pillars.performance * 0.30).toFixed(1)}`)
  console.log(`  Seller Quality:  ${String(r.pillars.seller_quality).padStart(3)}  × 0.20 = ${(r.pillars.seller_quality * 0.20).toFixed(1)}`)
  console.log(`  Price+Marketing: ${String(r.pillars.price_marketing).padStart(3)}  × 0.10 = ${(r.pillars.price_marketing * 0.10).toFixed(1)}`)
}

console.log('\n' + '═'.repeat(70))
console.log(allOk ? '✓ TODOS OK — formulas calibradas' : '✗ FALHA — re-calibrar')
process.exit(allOk ? 0 : 1)
