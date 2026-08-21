#!/usr/bin/env node
/**
 * Confere a agregação de reputação (RPC ml_reputation_account_counts) em
 * contas reais e compara com o oficial do ML guardado em
 * ml_seller_reputation_current. Read-only.
 *
 * Uso: node scripts/ml-reputation-rpc-check.mjs [orgId]
 *   sem orgId → percorre todas as conexões ML.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env'), quiet: true })
const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
const base = URL.replace(/\/+$/, '') + '/rest/v1/'
const get  = async p => (await fetch(base + p, { headers: H })).json()
const rpc  = async (fn, body) => { const r = await fetch(base + 'rpc/' + fn, { method: 'POST', headers: H, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) } }

const orgFilter = process.argv[2] ? `&organization_id=eq.${process.argv[2]}` : ''
const conns = await get(`ml_connections?select=organization_id,seller_id,nickname${orgFilter}`)
const pct = (a, b) => b > 0 ? (a / b * 100).toFixed(2) + '%' : '—'
const off = v => v == null ? '—' : (Number(v) * 100).toFixed(2) + '%'

for (const c of conns) {
  const t0 = Date.now()
  const r = await rpc('ml_reputation_account_counts', { p_org: c.organization_id, p_seller: c.seller_id, p_now: new Date().toISOString(), p_short_days: 60, p_long_days: 365 })
  const ms = Date.now() - t0
  console.log(`\n== ${c.nickname ?? c.seller_id} (seller ${c.seller_id}, org ${c.organization_id.slice(0, 8)}) — RPC ${r.status} em ${ms}ms`)
  if (r.status !== 200 || !r.body) { console.log('  ERRO:', JSON.stringify(r.body).slice(0, 300)); continue }
  const b = r.body
  const period = b.short.completed >= 68 ? 60 : 365
  const w = period === 60 ? b.short : b.long
  console.log(`  60d: concluídas=${b.short.completed} consideradas=${b.short.counted} cancel_seller=${b.short.seller_cancelled} claims=${b.short.claims} atrasos=${b.short.shipping_issues}`)
  console.log(`  365d: concluídas=${b.long.completed} consideradas=${b.long.counted} cancel_seller=${b.long.seller_cancelled} claims=${b.long.claims} atrasos=${b.long.shipping_issues}`)
  console.log(`  período (68) = ${period}d → cancel ${pct(w.seller_cancelled, w.counted)} · envios ${pct(w.shipping_issues, w.counted)} · reclamações ${pct(w.claims, w.counted)}`)
  console.log(`  cobertura: cancel_detail ${b.cancel_detail_coverage.cancelled_with_detail}/${b.cancel_detail_coverage.cancelled_total} · pedido mais antigo ${b.oldest_sale_at ?? '—'} · claims desde ${b.claims_since ?? '—'} · atrasos desde ${b.delays_since ?? '—'} · saídas 14d: ${b.window_exits.length}`)
  const [o] = await get(`ml_seller_reputation_current?select=level_id,claims_rate,cancellations_rate,delayed_handling_rate,claims_count,cancellations_count,delayed_handling_count,last_synced_at&organization_id=eq.${c.organization_id}&seller_id=eq.${c.seller_id}`)
  if (o) console.log(`  OFICIAL ML (${o.level_id}, sync ${o.last_synced_at}): cancel ${off(o.cancellations_rate)} (${o.cancellations_count}) · atrasos ${off(o.delayed_handling_rate)} (${o.delayed_handling_count}) · reclamações ${off(o.claims_rate)} (${o.claims_count})`)
  else console.log('  OFICIAL ML: sem linha em ml_seller_reputation_current')
}
