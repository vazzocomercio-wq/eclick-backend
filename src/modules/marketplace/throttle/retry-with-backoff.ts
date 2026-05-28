import { Logger } from '@nestjs/common'
import axios, { AxiosError } from 'axios'

/** F18 F0.6 — Retry com backoff exponencial pra calls outbound a marketplaces.
 *
 *  Retry em: 429 (rate limit), 502/503/504 (gateway/timeout transient).
 *  NÃO retry em: 400/401/403 (erro de input/auth — não muda com retry).
 *
 *  Backoff: 1s → 4s → 16s, cap 30s. Respeita header `Retry-After` quando
 *  presente (Shopee não documenta mas é HTTP standard; ML manda em 429).
 *
 *  Max 3 tentativas total (1 original + 2 retries). Se esgotar, re-throw o
 *  último erro pra o caller decidir (registrar em
 *  marketplace_webhook_events.processor_error ou propagar).
 */

const log = new Logger('marketplace.retry')

export interface RetryOpts {
  /** Tentativas totais (1 original + N retries). Default 3. */
  maxAttempts?: number
  /** Backoff base em ms. Default 1000. Sequência: base, base*4, base*16, ... */
  baseMs?:      number
  /** Cap superior do backoff. Default 30000. */
  capMs?:       number
  /** Tag pra log (ex: 'shopee.listOrders'). Ajuda debug. */
  tag?:         string
}

/** Executa `fn` com retry em 429/5xx + backoff exponencial. */
export async function retryWithBackoff<T>(
  fn:   () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3
  const baseMs      = opts.baseMs      ?? 1000
  const capMs       = opts.capMs       ?? 30_000
  const tag         = opts.tag         ?? 'retry'

  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      lastErr = err
      const status = httpStatusOf(err)
      const retryable = isRetryable(status)
      if (!retryable || attempt >= maxAttempts) {
        if (attempt > 1) {
          log.warn(`[${tag}] esgotou ${attempt}/${maxAttempts} attempts — re-throw`)
        }
        throw err
      }
      const waitMs = computeWait({
        attempt,
        baseMs,
        capMs,
        retryAfterHeader: retryAfterMsOf(err),
      })
      log.warn(`[${tag}] attempt ${attempt}/${maxAttempts} falhou (status=${status ?? '?'}) — backoff ${waitMs}ms`)
      await sleep(waitMs)
    }
  }
  // unreachable — for/throw garantem saída
  throw lastErr
}

/** 429 e 5xx (502/503/504) são transient. 5xx 500 é incerto — não retry
 *  por padrão (pode ser bug no body que vai falhar de novo). */
function isRetryable(status: number | null): boolean {
  if (status === null) return true // network error / timeout — retry
  if (status === 429)  return true
  if (status === 502 || status === 503 || status === 504) return true
  return false
}

function httpStatusOf(err: unknown): number | null {
  if (axios.isAxiosError(err)) {
    const ae = err as AxiosError
    return ae.response?.status ?? null
  }
  return null
}

/** Lê Retry-After (segs ou data HTTP). Retorna ms, ou null se ausente/inválido. */
function retryAfterMsOf(err: unknown): number | null {
  if (!axios.isAxiosError(err)) return null
  const h = err.response?.headers?.['retry-after']
  if (!h) return null
  const s = String(h).trim()
  const secs = Number(s)
  if (!Number.isNaN(secs) && secs >= 0) return Math.floor(secs * 1000)
  const date = Date.parse(s)
  if (!Number.isNaN(date)) {
    const diff = date - Date.now()
    return diff > 0 ? diff : 0
  }
  return null
}

interface ComputeWaitInput {
  attempt:          number
  baseMs:           number
  capMs:            number
  retryAfterHeader: number | null
}

/** Retry-After do servidor > backoff exponencial. */
function computeWait(input: ComputeWaitInput): number {
  if (input.retryAfterHeader != null) return Math.min(input.retryAfterHeader, input.capMs)
  const exp = input.baseMs * Math.pow(4, input.attempt - 1)
  // Jitter ±20% pra evitar thundering herd quando N tasks falham juntas.
  const jitter = exp * (0.8 + Math.random() * 0.4)
  return Math.min(Math.floor(jitter), input.capMs)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
