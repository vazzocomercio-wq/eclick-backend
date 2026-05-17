import { getSupabase } from '../supabase.js'
import { loadOrgToken } from './token-client.js'
import { collectOffers } from './collectors/offers.js'
import { collectVisits } from './collectors/visits.js'
import { collectSellers } from './collectors/sellers.js'
import { collectDiscovery } from './collectors/discovery.js'
import type { RunType } from './types.js'
import { radarLog, errMsg } from './util.js'

/** Orgs que têm watchlist do Radar. activeOnly=true filtra produtos ativos. */
async function orgsWithWatchlist(activeOnly: boolean): Promise<string[]> {
  const sb = getSupabase()
  let q = sb.from('radar_catalog_products').select('organization_id')
  if (activeOnly) q = q.eq('status', 'ativo')
  const { data, error } = await q
  if (error) throw new Error(`orgsWithWatchlist: ${error.message}`)
  return [...new Set((data ?? []).map((row) => row.organization_id as string))]
}

/** Já existe rodada `completed` do tipo, dentro da janela? (idempotência + catch-up) */
async function hasRecentRun(orgId: string, runType: RunType, sinceIso: string): Promise<boolean> {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('radar_collection_runs')
    .select('id')
    .eq('organization_id', orgId)
    .eq('run_type', runType)
    .eq('status', 'completed')
    .gte('started_at', sinceIso)
    .limit(1)
  if (error) throw new Error(`hasRecentRun: ${error.message}`)
  return (data ?? []).length > 0
}

async function startRun(orgId: string, runType: RunType): Promise<string> {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('radar_collection_runs')
    .insert({ organization_id: orgId, run_type: runType, status: 'running' })
    .select('id')
    .single()
  if (error || !data) throw new Error(`startRun: ${error?.message ?? 'sem id'}`)
  return data.id as string
}

async function finishRun(
  runId: string,
  status: 'completed' | 'failed',
  stats: unknown,
  error?: string,
): Promise<void> {
  const sb = getSupabase()
  await sb
    .from('radar_collection_runs')
    .update({
      status,
      finished_at: new Date().toISOString(),
      stats: stats ?? null,
      error: error ?? null,
    })
    .eq('id', runId)
}

/**
 * Rodada DIÁRIA — ofertas → visitas → sellers, para cada org com watchlist
 * ativa. Idempotente: pula org que já tem rodada `daily` completa hoje (UTC).
 */
export async function runDaily(force = false): Promise<void> {
  const startOfDay = new Date()
  startOfDay.setUTCHours(0, 0, 0, 0)
  const sinceIso = startOfDay.toISOString()

  const orgs = await orgsWithWatchlist(true)
  radarLog('orchestrator', `runDaily — ${orgs.length} org(s) com watchlist ativa${force ? ' (forçado)' : ''}`)

  for (const orgId of orgs) {
    if (!force && (await hasRecentRun(orgId, 'daily', sinceIso))) {
      radarLog('orchestrator', `org=${orgId} — rodada diária já completa hoje, pula`)
      continue
    }
    const runId = await startRun(orgId, 'daily')
    const t0 = Date.now()
    try {
      const tok = await loadOrgToken(orgId)
      const offers = await collectOffers(orgId, tok)
      const visits = await collectVisits(orgId, tok)
      const sellers = await collectSellers(orgId, tok)
      const stats = { offers, visits, sellers, duration_ms: Date.now() - t0 }
      await finishRun(runId, 'completed', stats)
      radarLog('orchestrator', `org=${orgId} daily OK`, JSON.stringify(stats))
    } catch (e) {
      const m = errMsg(e)
      await finishRun(runId, 'failed', { duration_ms: Date.now() - t0 }, m)
      radarLog('orchestrator', `org=${orgId} daily FALHOU: ${m}`)
    }
  }
}

/**
 * Rodada de DESCOBERTA — amplia a watchlist lendo o catálogo próprio.
 * Cadência semanal: pula org com rodada `discovery` completa nos últimos 7d.
 */
export async function runDiscovery(force = false): Promise<void> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const orgs = await orgsWithWatchlist(false)
  radarLog('orchestrator', `runDiscovery — ${orgs.length} org(s)${force ? ' (forçado)' : ''}`)

  for (const orgId of orgs) {
    if (!force && (await hasRecentRun(orgId, 'discovery', sevenDaysAgo))) {
      radarLog('orchestrator', `org=${orgId} — discovery recente (<7d), pula`)
      continue
    }
    const runId = await startRun(orgId, 'discovery')
    const t0 = Date.now()
    try {
      const tok = await loadOrgToken(orgId)
      const discovery = await collectDiscovery(orgId, tok)
      const stats = { discovery, duration_ms: Date.now() - t0 }
      await finishRun(runId, 'completed', stats)
      radarLog('orchestrator', `org=${orgId} discovery OK`, JSON.stringify(stats))
    } catch (e) {
      const m = errMsg(e)
      await finishRun(runId, 'failed', { duration_ms: Date.now() - t0 }, m)
      radarLog('orchestrator', `org=${orgId} discovery FALHOU: ${m}`)
    }
  }
}
