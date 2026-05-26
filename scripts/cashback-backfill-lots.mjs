#!/usr/bin/env node
/**
 * Backfill do cashback FIFO — preenche `remaining_cents` dos earns já
 * existentes (migration 20260645).
 *
 * Modelo: cada earn é um LOTE. O resgate consome FIFO (vence-antes-sai-antes),
 * então o saldo que SOBRA está logicamente nos lotes que vencem por ÚLTIMO.
 * Como o histórico não rastreava lote-a-lote, reconstruímos a partir da
 * verdade atual (balance_cents):
 *
 *   - lotes expirados (expires_at <= now)          → remaining = 0
 *   - lotes ativos, preenchidos do que vence DEPOIS pro que vence ANTES:
 *       remaining = min(amount, saldo_restante); saldo_restante -= remaining
 *   - sobra de saldo (balance > Σ amounts ativos)  → inconsistência pré-existente,
 *       logada (não inventamos lote; balance_cents segue como verdade do resgate)
 *
 * Garante a invariante: Σ remaining(ativos) == min(balance, Σ amounts ativos).
 * Idempotente — recomputa do balance a cada run.
 *
 * Uso:
 *   node scripts/cashback-backfill-lots.mjs            # DRY-RUN (só relatório)
 *   node scripts/cashback-backfill-lots.mjs --apply    # grava
 *   node scripts/cashback-backfill-lots.mjs <ORG_UUID> [--apply]
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA_URL = process.env.SUPABASE_URL
const SVC_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY
if (!SUPA_URL || !SVC_KEY) {
  console.error('[backfill] FATAL: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes no .env')
  process.exit(1)
}

const args   = process.argv.slice(2)
const APPLY  = args.includes('--apply')
const ORG    = args.find(a => !a.startsWith('--')) ?? null
const NOW    = new Date().toISOString()

const admin = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } })

function n(v) { return Number(v ?? 0) }

async function main() {
  console.log(`[backfill] modo=${APPLY ? 'APPLY (grava)' : 'DRY-RUN (só relatório)'} org=${ORG ?? 'TODAS'} now=${NOW}`)

  let balQ = admin.from('customer_cashback_balances').select('organization_id, customer_identifier, balance_cents')
  if (ORG) balQ = balQ.eq('organization_id', ORG)
  const { data: balances, error: balErr } = await balQ
  if (balErr) { console.error('[backfill] erro lendo balances:', balErr.message); process.exit(1) }

  let custs = 0, lotsUpdated = 0, mismatchesAfter = 0, overflowCustomers = 0
  for (const b of balances ?? []) {
    custs++
    const orgId = b.organization_id, email = b.customer_identifier, balance = n(b.balance_cents)

    const { data: earns } = await admin
      .from('customer_cashback_movements')
      .select('id, amount_cents, remaining_cents, expires_at, created_at')
      .eq('organization_id', orgId)
      .eq('customer_identifier', email)
      .eq('type', 'earn')
    const lots = (earns ?? []).map(e => ({
      id: e.id, amount: n(e.amount_cents), expires_at: e.expires_at, created_at: e.created_at,
    }))

    const expired = lots.filter(l => l.expires_at && l.expires_at <= NOW)
    const active  = lots.filter(l => !l.expires_at || l.expires_at > NOW)
    // Preenche do que vence por ÚLTIMO (NULL=nunca) pro que vence antes.
    active.sort((a, c) => {
      const ax = a.expires_at ?? '9999-12-31', cx = c.expires_at ?? '9999-12-31'
      if (ax !== cx) return cx < ax ? -1 : 1            // expires_at DESC (nunca-expira primeiro)
      return (c.created_at ?? '') < (a.created_at ?? '') ? -1 : 1  // created_at DESC
    })

    let left = balance
    const target = new Map()           // lotId → remaining alvo
    for (const l of expired) target.set(l.id, 0)
    for (const l of active) {
      const give = Math.min(l.amount, Math.max(0, left))
      target.set(l.id, give)
      left -= give
    }
    if (left > 0) { overflowCustomers++; console.warn(`[backfill] ⚠ ${email} (org ${orgId.slice(0,8)}): saldo ${balance}c > Σ lotes ativos — sobra ${left}c sem lote (inconsistência pré-existente)`) }

    // Aplica só onde mudou
    for (const l of lots) {
      const want = target.get(l.id) ?? 0
      const cur  = l.remaining_cents
      if (cur === want) continue
      if (APPLY) {
        const { error } = await admin
          .from('customer_cashback_movements')
          .update({ remaining_cents: want })
          .eq('id', l.id)
        if (error) { console.error(`[backfill] erro update lote ${l.id}: ${error.message}`); continue }
      }
      lotsUpdated++
    }

    // Reconcile pós: Σ remaining(ativos) deveria == min(balance, Σ amounts ativos)
    const activeSum = active.reduce((s, l) => s + (target.get(l.id) ?? 0), 0)
    const expectedActive = Math.min(balance, active.reduce((s, l) => s + l.amount, 0))
    if (activeSum !== expectedActive) { mismatchesAfter++; console.warn(`[backfill] ⚠ reconcile ${email}: Σativo=${activeSum}c esperado=${expectedActive}c`) }
  }

  console.log(`[backfill] clientes=${custs} lotes_${APPLY ? 'atualizados' : 'a_atualizar'}=${lotsUpdated} overflow=${overflowCustomers} reconcile_falhas=${mismatchesAfter}`)
  if (!APPLY) console.log('[backfill] DRY-RUN — rode de novo com --apply pra gravar.')
}

main().catch(e => { console.error('[backfill] FATAL:', e); process.exit(1) })
