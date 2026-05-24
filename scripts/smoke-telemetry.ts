/**
 * Smoke da Fase 1 (Telemetria). Instancia o EventIngestionService real e
 * manda 100 eventos válidos + 10 inválidos contra o banco de prod.
 *
 * Esperado: { accepted: 100, rejected: 10 } + 100 linhas em telemetry_events
 * + sessão criada + chave sensível ("email") removida do properties.
 *
 * Limpa as linhas de teste no fim (delete por session_id).
 *
 * Uso: npx tsx scripts/smoke-telemetry.ts
 */
import 'reflect-metadata'
import { config } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const VAZZO_ORG = '4ef1aabd-c209-40b0-b034-ef69dcb66833'

async function main() {
  // Import dinâmico DEPOIS do dotenv (supabaseAdmin lê env no load).
  const { supabaseAdmin } = await import('../src/common/supabase')
  const { EventIngestionService } = await import('../src/modules/product-telemetry/services/event-ingestion.service')
  const { SessionService } = await import('../src/modules/product-telemetry/services/session.service')
  const { TELEMETRY_EVENTS, MODULES } = await import('../src/modules/product-telemetry/catalog/events-catalog')

  // user_id real da org (sem FK, mas vamos usar um de verdade).
  const { data: member } = await supabaseAdmin
    .from('organization_members')
    .select('user_id')
    .eq('organization_id', VAZZO_ORG)
    .limit(1)
    .maybeSingle()
  const userId = (member as { user_id?: string } | null)?.user_id ?? randomUUID()

  const ingestion = new EventIngestionService(new SessionService())
  const sessionId = randomUUID()
  const eventNames = Object.values(TELEMETRY_EVENTS)
  const modules = Object.values(MODULES)

  // 100 válidos — varre o catálogo. properties traz "email" (deve sumir).
  const valid = Array.from({ length: 100 }, (_, i) => ({
    event_name: eventNames[i % eventNames.length],
    module:     modules[i % modules.length],
    feature:    'smoke',
    properties: { idx: i, ok: true, email: 'leak@should-be-stripped.com' },
  }))

  // 10 inválidos — metade event_name fora do catálogo, metade module inválido.
  const invalid = Array.from({ length: 10 }, (_, i) => ({
    event_name: i % 2 === 0 ? 'totally.fake_event' : TELEMETRY_EVENTS.PAGE_VIEW,
    module:     i % 2 === 0 ? MODULES.DASHBOARD : 'fake_module',
  }))

  const res = await ingestion.ingestBatch({
    orgId:     VAZZO_ORG,
    userId,
    sessionId,
    events:    [...valid, ...invalid],
    userAgent: 'smoke/1.0',
    ip:        '203.0.113.7',
  })
  console.log('ingestBatch →', JSON.stringify(res))

  // Verificações
  const { count } = await supabaseAdmin
    .from('telemetry_events')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)

  const { data: sample } = await supabaseAdmin
    .from('telemetry_events')
    .select('properties, event_type, event_name')
    .eq('session_id', sessionId)
    .limit(1)
    .maybeSingle()

  const { data: session } = await supabaseAdmin
    .from('telemetry_sessions')
    .select('id, events_count')
    .eq('id', sessionId)
    .maybeSingle()

  // end-session
  const sessions = new SessionService()
  const ended = await sessions.end({ orgId: VAZZO_ORG, userId, sessionId })

  const { data: closed } = await supabaseAdmin
    .from('telemetry_sessions')
    .select('ended_at, duration_s, events_count, modules_visited')
    .eq('id', sessionId)
    .maybeSingle()

  const props = (sample as { properties?: Record<string, unknown> } | null)?.properties ?? {}
  const emailStripped = !('email' in props)

  console.log('---- VERIFICAÇÕES ----')
  console.log('accepted == 100 :', res.accepted === 100)
  console.log('rejected == 10  :', res.rejected === 10)
  console.log('linhas inseridas:', count, '(esperado 100)')
  console.log('sessão criada   :', !!session)
  console.log('email removido  :', emailStripped, '| props sample =', JSON.stringify(props))
  console.log('end-session ok  :', ended.ended, '| fechada =', JSON.stringify(closed))

  const pass =
    res.accepted === 100 &&
    res.rejected === 10 &&
    count === 100 &&
    !!session &&
    emailStripped &&
    ended.ended

  // Cleanup — não poluir prod.
  await supabaseAdmin.from('telemetry_events').delete().eq('session_id', sessionId)
  await supabaseAdmin.from('telemetry_sessions').delete().eq('id', sessionId)
  console.log('cleanup: linhas de teste removidas')

  console.log(pass ? '\n✅ SMOKE PASSOU' : '\n❌ SMOKE FALHOU')
  process.exit(pass ? 0 : 1)
}

main().catch(e => {
  console.error('smoke erro:', e)
  process.exit(1)
})
