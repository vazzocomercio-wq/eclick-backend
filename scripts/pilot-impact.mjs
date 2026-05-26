#!/usr/bin/env node
/**
 * Lê o relatório de impacto do piloto GEO Optimizer (Dia 14) pelo backend de
 * produção: GET /ai-visibility/optimize/impact. Hoje retorna verdict=pending
 * (janela aberta); a partir de 11/06 dá o veredito GO/NO-GO do Risco 2.
 * Faz poll até o deploy subir (a rota é nova).
 *
 * Uso: node scripts/pilot-impact.mjs
 */
import { config } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
const BACKEND = 'https://eclick-backend-production-2a87.up.railway.app'
const EMAIL = 'vazzocomercio@gmail.com'

async function mintJwt() {
  const g = await fetch(`${SUPA}/auth/v1/admin/generate_link`, {
    method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email: EMAIL }),
  })
  const gj = await g.json()
  const hashed = gj?.properties?.hashed_token || gj?.hashed_token
  if (!hashed) throw new Error(`generate_link falhou: ${JSON.stringify(gj).slice(0, 300)}`)
  const v = await fetch(`${SUPA}/auth/v1/verify`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed }),
  })
  const vj = await v.json()
  if (!vj.access_token) throw new Error(`verify falhou: ${JSON.stringify(vj).slice(0, 300)}`)
  return vj.access_token
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const jwt = await mintJwt()
  let rep = null
  for (let i = 1; i <= 18; i++) {
    const res = await fetch(`${BACKEND}/ai-visibility/optimize/impact`, { headers: { Authorization: `Bearer ${jwt}` } })
    const txt = await res.text(); let j; try { j = JSON.parse(txt) } catch { j = null }
    if (res.status === 200 && j && typeof j.verdict === 'string') { rep = j; break }
    console.log(`  aguardando deploy… tentativa ${i} (status ${res.status})`)
    await sleep(10_000)
  }
  if (!rep) { console.error('Endpoint não respondeu o relatório (deploy ainda subindo?).'); process.exit(1) }

  console.log(`\n=== Impacto do Piloto GEO Optimizer ===`)
  console.log(`Gerado: ${rep.generated_at}`)
  console.log(`Veredito: ${rep.verdict}  |  wins ${rep.win_count}/${rep.measured} medidos (meta ≥${rep.threshold}) | pendentes ${rep.pending} | limite/métrica +${rep.delta_pct}%\n`)
  for (const l of rep.listings) {
    const tag = l.note === 'window_open' ? `⏳ janela aberta (faltam ${l.days_remaining}d, fecha ${l.window_to})`
      : l.note === 'rolled_back' ? '↩️ revertido'
      : l.note === 'no_product' ? '⚠️ sem product_id (venda N/A)'
      : (l.is_win ? '✅ WIN' : '➖ sem ganho ≥20%')
    console.log(`── ${l.sku ?? '(sku?)'} ${l.listing_id} — ${tag}`)
    for (const m of l.metrics) {
      const pct = m.delta_pct === null ? (l.window_elapsed ? 'N/A' : '—') : `${m.delta_pct > 0 ? '+' : ''}${m.delta_pct}%`
      console.log(`     ${m.metric.padEnd(8)} antes=${m.before}  depois=${m.after ?? '—'}  Δ=${pct}${m.improved ? ' ✓' : ''}`)
    }
    console.log('')
  }
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1) })
