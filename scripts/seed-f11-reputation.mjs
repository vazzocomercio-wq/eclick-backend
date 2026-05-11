#!/usr/bin/env node
/**
 * Seed inicial pra F11 E2 Reputação.
 *
 * Replica a lógica do ExecutiveReputationService.syncReputation() mas
 * standalone (sem precisar subir o servidor). Pra popular `ml_seller_reputation_*`
 * imediatamente após deploy ou em rollouts pra novas orgs.
 *
 * Uso:
 *   node scripts/seed-f11-reputation.mjs                  → todas as orgs
 *   node scripts/seed-f11-reputation.mjs <ORG_UUID>       → 1 org
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA_URL = process.env.SUPABASE_URL
const SVC_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY
const ML_CLIENT_ID     = process.env.ML_CLIENT_ID
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET

if (!SUPA_URL || !SVC_KEY || !ML_CLIENT_ID || !ML_CLIENT_SECRET) {
  console.error('[seed] env missing')
  process.exit(1)
}

const RISK = { claims: 0.008, cancellations: 0.004, late_handling: 0.05 }
const LEVEL_COLOR = {
  '5_green':       'green',
  '4_light_green': 'light_green',
  '3_yellow':      'yellow',
  '2_orange':      'orange',
  '1_red':         'red',
  '0_red':         'red',
}
const ML_LEVELS = new Set(['5_green', '4_light_green', '3_yellow'])

const admin = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } })
const targetOrg = process.argv[2] ?? null

let q = admin.from('ml_connections').select('organization_id, seller_id, access_token, refresh_token, expires_at')
if (targetOrg) q = q.eq('organization_id', targetOrg)
const { data: conns, error } = await q
if (error) { console.error('[seed] conns:', error.message); process.exit(1) }
console.log(`[seed] ${conns.length} contas a processar`)

let ok = 0, fail = 0
for (const conn of conns) {
  try {
    let token = conn.access_token
    if (new Date(conn.expires_at) <= new Date(Date.now() + 60_000)) {
      const r = await fetch('https://api.mercadolibre.com/oauth/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          grant_type:    'refresh_token',
          client_id:     ML_CLIENT_ID,
          client_secret: ML_CLIENT_SECRET,
          refresh_token: conn.refresh_token,
        }),
      })
      if (!r.ok) throw new Error(`refresh ${r.status}`)
      const j = await r.json()
      token = j.access_token
      await admin
        .from('ml_connections')
        .update({
          access_token:  j.access_token,
          refresh_token: j.refresh_token,
          expires_at:    new Date(Date.now() + j.expires_in * 1000).toISOString(),
          updated_at:    new Date().toISOString(),
        })
        .eq('organization_id', conn.organization_id)
        .eq('seller_id',       conn.seller_id)
    }

    const userRes = await fetch(`https://api.mercadolibre.com/users/${conn.seller_id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!userRes.ok) throw new Error(`/users/${conn.seller_id} ${userRes.status}`)
    const user = await userRes.json()
    const sr   = user.seller_reputation ?? {}
    const m    = sr.metrics ?? {}
    const claims = m.claims ?? {}
    const cancel = m.cancellations ?? {}
    const dela   = m.delayed_handling_time ?? {}
    const tx     = sr.transactions ?? {}
    const ra     = tx.ratings ?? {}

    const claimsRate  = claims.rate ?? null
    const cancelRate  = cancel.rate ?? null
    const delayedRate = dela.rate ?? null

    const reasons = []
    if (claimsRate  != null && claimsRate  >= RISK.claims)        reasons.push('claims_above_0_8')
    if (cancelRate  != null && cancelRate  >= RISK.cancellations) reasons.push('cancellations_above_0_4')
    if (delayedRate != null && delayedRate >= RISK.late_handling) reasons.push('late_handling_above_5')
    const isAtRisk = reasons.length > 0

    const levelId    = sr.level_id ?? null
    const levelColor = levelId ? LEVEL_COLOR[levelId] ?? null : null
    const isMl       = levelId ? ML_LEVELS.has(levelId) : false

    const snapshot = {
      organization_id:        conn.organization_id,
      seller_id:              conn.seller_id,
      snapshot_date:          new Date().toISOString().slice(0, 10),
      level_id:               levelId,
      level_color:            levelColor,
      power_seller_status:    sr.power_seller_status ?? null,
      total_transactions:     tx.total     ?? null,
      completed_transactions: tx.completed ?? null,
      cancelled_transactions: tx.canceled  ?? null,
      claims_rate:            claimsRate,
      claims_count:           claims.value ?? null,
      claims_period:          claims.period ?? null,
      cancellations_rate:     cancelRate,
      cancellations_count:    cancel.value ?? null,
      cancellations_period:   cancel.period ?? null,
      delayed_handling_rate:  delayedRate,
      delayed_handling_count: dela.value ?? null,
      delayed_period:         dela.period ?? null,
      transactions_period:    tx.period ?? null,
      positive_ratings:       ra.positive ?? null,
      neutral_ratings:        ra.neutral  ?? null,
      negative_ratings:       ra.negative ?? null,
      is_mercado_lider:       isMl,
      is_at_risk:             isAtRisk,
      risk_reasons:           reasons,
      raw:                    sr,
    }

    const { error: snapErr } = await admin
      .from('ml_seller_reputation_snapshots')
      .insert(snapshot)
    if (snapErr) throw new Error(`snap insert: ${snapErr.message}`)

    const current = {
      organization_id:        conn.organization_id,
      seller_id:              conn.seller_id,
      level_id:               levelId,
      level_color:            levelColor,
      power_seller_status:    sr.power_seller_status ?? null,
      claims_rate:            claimsRate,
      cancellations_rate:     cancelRate,
      delayed_handling_rate:  delayedRate,
      claims_count:           claims.value ?? null,
      cancellations_count:    cancel.value ?? null,
      delayed_handling_count: dela.value ?? null,
      total_transactions:     tx.total     ?? null,
      completed_transactions: tx.completed ?? null,
      cancelled_transactions: tx.canceled  ?? null,
      positive_ratings:       ra.positive ?? null,
      neutral_ratings:        ra.neutral  ?? null,
      negative_ratings:       ra.negative ?? null,
      is_mercado_lider:       isMl,
      is_at_risk:             isAtRisk,
      risk_reasons:           reasons,
      trend:                  'unknown',  // sem snapshot anterior pra seed
      trend_calculated_at:    new Date().toISOString(),
      last_synced_at:         new Date().toISOString(),
      next_sync_at:           new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }
    const { error: curErr } = await admin
      .from('ml_seller_reputation_current')
      .upsert(current, { onConflict: 'organization_id,seller_id' })
    if (curErr) throw new Error(`current upsert: ${curErr.message}`)

    const pct = (v) => v == null ? '?' : (v * 100).toFixed(2) + '%'
    console.log(`  ✓ seller=${conn.seller_id} level=${levelId} claims=${pct(claimsRate)} late=${pct(delayedRate)} ${isAtRisk ? '⚠ AT RISK' : ''}`)
    ok++
  } catch (err) {
    console.warn(`  ✗ seller=${conn.seller_id}: ${err.message}`)
    fail++
  }
}

console.log(`\n[seed] ${ok}/${conns.length} ok, ${fail} falhas`)
process.exit(fail === 0 ? 0 : 1)
