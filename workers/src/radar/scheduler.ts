import { runDaily, runDiscovery } from './orchestrator.js'
import { radarLog, errMsg } from './util.js'

/**
 * Scheduler do e-Click Radar IA.
 *
 * Robustez (decisão R2-B): NÃO usa setTimeout auto-reagendado — isso deriva e
 * pode disparar duplicado em restart do Railway. Em vez disso:
 *   - Check periódico ancorado no RELÓGIO (a cada 30min).
 *   - Dispara as rodadas a partir de 03:00 UTC (≈ 00:00 BRT).
 *   - A idempotência mora no orchestrator (tabela radar_collection_runs):
 *     runDaily roda 1×/dia, runDiscovery 1×/7d — chamar a cada tick é seguro.
 *   - Catch-up: o primeiro tick roda no boot; se o worker subiu depois das
 *     03:00 e a rodada do dia não aconteceu, ela roda agora.
 */

const CHECK_INTERVAL_MS = 30 * 60_000
const DAILY_HOUR_UTC = 3

let timer: NodeJS.Timeout | null = null
let ticking = false

async function tick(): Promise<void> {
  if (ticking) {
    radarLog('scheduler', 'tick anterior ainda rodando — pula')
    return
  }
  if (new Date().getUTCHours() < DAILY_HOUR_UTC) return // antes da janela diária

  ticking = true
  try {
    // Ambos idempotentes via radar_collection_runs — seguro chamar a cada tick.
    await runDaily()
    await runDiscovery()
  } catch (e) {
    radarLog('scheduler', 'tick falhou', errMsg(e))
  } finally {
    ticking = false
  }
}

export function startRadarScheduler(): void {
  radarLog(
    'scheduler',
    `iniciado — check a cada ${CHECK_INTERVAL_MS / 60_000}min, janela diária >= ${DAILY_HOUR_UTC}h UTC`,
  )
  void tick() // catch-up imediato no boot
  timer = setInterval(() => void tick(), CHECK_INTERVAL_MS)
}

export function stopRadarScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/**
 * Gatilho manual (smokes R2/R3) — força uma rodada agora, ignorando o horário
 * e a idempotência. Fire-and-forget: quem chama checa radar_collection_runs.
 */
export async function triggerManual(kind: 'daily' | 'discovery' | 'both'): Promise<void> {
  if (kind === 'daily' || kind === 'both') await runDaily(true)
  if (kind === 'discovery' || kind === 'both') await runDiscovery(true)
}
