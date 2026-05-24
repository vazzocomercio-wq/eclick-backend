/**
 * Smoke da Fase 3 (Telemetria — workers/agregação).
 *
 * Insere eventos sintéticos backdated (2 dias × 3 módulos) pra um usuário de
 * teste + 1 sessão ociosa, roda runRollup + runEngagement e confere:
 *  - telemetry_events_daily populada (6 linhas: 2 dias × 3 módulos)
 *  - sessão ociosa (>30min) fechada
 *  - telemetry_user_engagement: active_days=2, module_count=3, status=casual
 * Limpa todos os dados de teste no fim (por user_id sintético).
 *
 * Uso: npx tsx scripts/smoke-telemetry-rollup.ts
 */
import 'reflect-metadata'
import { config } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const VAZZO_ORG = '4ef1aabd-c209-40b0-b034-ef69dcb66833'
const MODULES = ['dashboard', 'campaigns', 'listings']

function brtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}

async function main() {
  const { supabaseAdmin } = await import('../src/common/supabase')
  const { RollupService } = await import('../src/modules/product-telemetry/services/rollup.service')
  const { EngagementService } = await import('../src/modules/product-telemetry/services/engagement.service')
  const { SessionService } = await import('../src/modules/product-telemetry/services/session.service')

  const TU = randomUUID()       // usuário de teste (sem FK)
  const SID = randomUUID()      // sessão ociosa
  const now = Date.now()
  const recent = new Date(now - 40 * 60 * 1000).toISOString()        // 40min atrás → idle
  const yesterday = `${brtDate(now - 30 * 3600 * 1000)}T10:00:00-03:00`

  // Sessão aberta há 1h (deve ser fechada pelo rollup).
  await supabaseAdmin.from('telemetry_sessions').insert({
    id: SID, org_id: VAZZO_ORG, user_id: TU,
    started_at: new Date(now - 60 * 60 * 1000).toISOString(),
  })

  // Eventos: 2 dias × 3 módulos. Por (dia,módulo): 1 entered + 2 page_view + 1 exited(120s).
  const rows: Array<Record<string, unknown>> = []
  for (const created_at of [yesterday, recent]) {
    for (const module of MODULES) {
      rows.push({ org_id: VAZZO_ORG, user_id: TU, session_id: SID, event_name: 'module_entered', event_type: 'navigation', module, created_at })
      rows.push({ org_id: VAZZO_ORG, user_id: TU, session_id: SID, event_name: 'page_view', event_type: 'navigation', module, created_at })
      rows.push({ org_id: VAZZO_ORG, user_id: TU, session_id: SID, event_name: 'page_view', event_type: 'navigation', module, created_at })
      rows.push({ org_id: VAZZO_ORG, user_id: TU, session_id: SID, event_name: 'module_exited', event_type: 'navigation', module, duration_ms: 120000, created_at })
    }
  }
  await supabaseAdmin.from('telemetry_events').insert(rows)

  // Roda os workers reais.
  const rollup = new RollupService(new SessionService())
  const rollupRes = await rollup.runRollup()
  const engagement = new EngagementService()
  const engRes = await engagement.runEngagement()

  // Verifica daily do usuário de teste.
  const { data: daily } = await supabaseAdmin
    .from('telemetry_events_daily')
    .select('date, module, visits, total_time_s, events_count')
    .eq('user_id', TU)
    .order('date', { ascending: true })

  // Verifica sessão fechada.
  const { data: session } = await supabaseAdmin
    .from('telemetry_sessions')
    .select('ended_at, duration_s, events_count, modules_visited')
    .eq('id', SID).maybeSingle()

  // Verifica engagement do usuário de teste.
  const { data: eng } = await supabaseAdmin
    .from('telemetry_user_engagement')
    .select('score, status, weekly_active_days, weekly_module_count, weekly_time_minutes, trend')
    .eq('user_id', TU).maybeSingle()

  const dailyRows = (daily ?? []) as Array<{ module: string; visits: number; total_time_s: number; events_count: number }>
  const e = eng as { score: number; status: string; weekly_active_days: number; weekly_module_count: number; weekly_time_minutes: number } | null
  const s = session as { ended_at: string | null; events_count: number; modules_visited: string[] } | null

  console.log('rollup →', JSON.stringify(rollupRes))
  console.log('engagement →', JSON.stringify(engRes))
  console.log('---- VERIFICAÇÕES ----')
  console.log('daily 6 linhas (2d×3mod):', dailyRows.length === 6, `(=${dailyRows.length})`)
  console.log('daily visits=2/módulo    :', dailyRows.every(r => r.visits === 2))
  console.log('daily events=4/módulo    :', dailyRows.every(r => r.events_count === 4))
  console.log('daily time=120s/módulo   :', dailyRows.every(r => r.total_time_s === 120))
  console.log('sessão fechada           :', !!s?.ended_at, `(events=${s?.events_count})`)
  console.log('engagement existe        :', !!e, e ? JSON.stringify(e) : '')
  console.log('  active_days=2          :', e?.weekly_active_days === 2)
  console.log('  module_count=3         :', e?.weekly_module_count === 3)
  console.log('  status=casual          :', e?.status === 'casual')

  const pass =
    dailyRows.length === 6 &&
    dailyRows.every(r => r.visits === 2 && r.events_count === 4 && r.total_time_s === 120) &&
    !!s?.ended_at &&
    !!e && e.weekly_active_days === 2 && e.weekly_module_count === 3 && e.status === 'casual'

  // Cleanup — só os dados de teste.
  await supabaseAdmin.from('telemetry_events').delete().eq('user_id', TU)
  await supabaseAdmin.from('telemetry_events_daily').delete().eq('user_id', TU)
  await supabaseAdmin.from('telemetry_user_engagement').delete().eq('user_id', TU)
  await supabaseAdmin.from('telemetry_sessions').delete().eq('id', SID)
  console.log('cleanup: dados de teste removidos')

  console.log(pass ? '\n✅ SMOKE FASE 3 PASSOU' : '\n❌ SMOKE FASE 3 FALHOU')
  process.exit(pass ? 0 : 1)
}

main().catch(e => { console.error('smoke erro:', e); process.exit(1) })
