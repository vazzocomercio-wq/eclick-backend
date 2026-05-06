import axios, { AxiosError } from 'axios'

/**
 * Retry com backoff exponencial + jitter pra chamadas de provedores externos
 * (Kling, OpenAI Image, ML). Resolve ~80% de falhas transientes que hoje
 * acabam virando posições `failed` no pipeline.
 *
 * Estratégia:
 *   - Tenta a função
 *   - Se erro for retryable (429, 5xx, network/timeout), espera + tenta de novo
 *   - Tetos: maxRetries (default 2) → 3 tentativas no total
 *   - Backoff: baseMs * 2^attempt + jitter (até 30% pra cima)
 */
export async function retryWithBackoff<T>(
  fn:    () => Promise<T>,
  opts:  { maxRetries?: number; baseMs?: number; label?: string } = {},
): Promise<T> {
  const max  = opts.maxRetries ?? 2
  const base = opts.baseMs     ?? 1000

  let lastError: unknown
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      return await fn()
    } catch (e: unknown) {
      lastError = e
      const retryable = isRetryable(e)
      const isLast    = attempt === max
      if (!retryable || isLast) throw e

      // Exponential backoff + jitter
      const delay = base * Math.pow(2, attempt) * (1 + Math.random() * 0.3)
      await sleep(delay)
    }
  }
  throw lastError
}

function isRetryable(e: unknown): boolean {
  if (!axios.isAxiosError(e)) return false
  const ax = e as AxiosError
  // Network / timeout — sem response é candidato perfeito a retry
  if (!ax.response) return true
  const status = ax.response.status
  // 429 Too Many Requests (rate limit), 5xx servidor, 408 timeout
  if (status === 429 || status === 408) return true
  if (status >= 500 && status < 600)    return true
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
