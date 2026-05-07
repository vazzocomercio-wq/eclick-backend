/**
 * Cálculo de horas úteis (08:00–18:00 segunda a sexta) no fuso
 * America/Sao_Paulo. Usado pra SLA de pós-venda.
 *
 * Implementação pura — sem dependência de date-fns/luxon. Trabalha com
 * Date e converte pro horário local de SP via Intl.DateTimeFormat.
 */

const BUSINESS_START_HOUR = 8
const BUSINESS_END_HOUR   = 18
const TZ                   = 'America/Sao_Paulo'

/** Pega componentes de data (year/month/day/hour/min/sec/weekday) no fuso TZ. */
function partsInTz(date: Date): { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
    hour:     '2-digit',
    minute:   '2-digit',
    second:   '2-digit',
    weekday:  'short',
    hour12:   false,
  })
  const parts = fmt.formatToParts(date)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  // weekday: Sun=0, Mon=1, ..., Sat=6
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    y:  parseInt(get('year'),   10),
    mo: parseInt(get('month'),  10),
    d:  parseInt(get('day'),    10),
    h:  parseInt(get('hour'),   10) % 24, // '24' vira 0 em alguns nodes
    mi: parseInt(get('minute'), 10),
    s:  parseInt(get('second'), 10),
    wd: weekdayMap[get('weekday')] ?? 0,
  }
}

/** Decimal de horas decorridas dentro do dia (já em fuso TZ). */
function hoursOfDayLocal(p: { h: number; mi: number; s: number }): number {
  return p.h + p.mi / 60 + p.s / 3600
}

/** Soma N dias mantendo o mesmo Y/M/D no fuso TZ. Como a mudança ocorre
 *  no Date "raw", usamos UTC midnight como aproximação — boa o bastante
 *  pra SLA (não precisa precisão sub-segundo). */
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000)
}

function isWeekend(wd: number): boolean {
  return wd === 0 || wd === 6
}

/**
 * Retorna o número de horas úteis decorridas entre `from` e `to`. Considera:
 *  - Janela diária 08:00–18:00 (10 horas/dia)
 *  - Sábado e domingo são pulados completamente
 *  - Feriados não são suportados no MVP 1
 */
export function businessHoursElapsed(from: Date, to: Date = new Date()): number {
  if (to.getTime() <= from.getTime()) return 0

  let elapsed = 0
  let cursor  = new Date(from.getTime())

  // Avança em incrementos de "fim do dia útil ou to, o que vier antes"
  // até cobrir tudo. Usamos a representação local em TZ pra clamping.
  // Loop bounded em ~365 dias pra segurança.
  for (let i = 0; i < 400; i++) {
    if (cursor.getTime() >= to.getTime()) break

    const cp = partsInTz(cursor)
    if (isWeekend(cp.wd)) {
      // Pula pra próxima 0:00 — adiciona 1 dia
      const next = nextLocalMidnight(cursor)
      cursor = next
      continue
    }

    // Hora local atual (decimal)
    const startOfDayLocal = hoursOfDayLocal({ h: cp.h, mi: cp.mi, s: cp.s })

    // Determina o fim útil de hoje (em ms relativos a cursor).
    // Fim útil = ponto onde local hits BUSINESS_END_HOUR.
    const remainingTodayHours =
      Math.max(0, BUSINESS_END_HOUR - Math.max(BUSINESS_START_HOUR, startOfDayLocal))

    if (remainingTodayHours <= 0) {
      // Já passou de 18:00 hoje — pula pro próximo dia 0:00
      cursor = nextLocalMidnight(cursor)
      continue
    }

    // Calcula em ms até o fim útil de hoje
    const localEffectiveStart = Math.max(BUSINESS_START_HOUR, startOfDayLocal)
    const hoursUntilEnd = BUSINESS_END_HOUR - localEffectiveStart
    const endOfBusinessToday = new Date(cursor.getTime() + (
      // Se começamos antes das 08:00, soma o gap até 08:00 também
      (BUSINESS_START_HOUR - startOfDayLocal > 0 ? (BUSINESS_START_HOUR - startOfDayLocal) : 0) * 3600_000
      + hoursUntilEnd * 3600_000
    ))

    const segEnd = endOfBusinessToday.getTime() < to.getTime() ? endOfBusinessToday : to
    const usableMs = segEnd.getTime() - cursor.getTime()
    // Subtrai o gap pré-08:00 se houver
    const preGapMs = startOfDayLocal < BUSINESS_START_HOUR
      ? (BUSINESS_START_HOUR - startOfDayLocal) * 3600_000
      : 0
    const businessMs = Math.max(0, usableMs - preGapMs)
    elapsed += businessMs / 3600_000

    if (segEnd.getTime() >= to.getTime()) break
    cursor = nextLocalMidnight(cursor)
  }

  return Math.round(elapsed * 100) / 100
}

/** Próxima meia-noite local (TZ). Avança ~24h e zera horas locais. */
function nextLocalMidnight(d: Date): Date {
  const p = partsInTz(d)
  // Quanto falta até 00:00 local? = 24 - hoursOfDayLocal
  const hoursToMidnight = 24 - hoursOfDayLocal(p)
  return new Date(d.getTime() + Math.max(60_000, hoursToMidnight * 3600_000))
}
