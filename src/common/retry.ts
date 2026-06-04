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
  // Aceita tanto AxiosError cru quanto erros "enriquecidos": o LlmService
  // re-lança axios errors como Error comum (pra anexar response.data na
  // mensagem), preservando `.response`. Se olhássemos só axios.isAxiosError,
  // TODO erro de imagem viraria não-retryable → o retry ficava morto.
  const resp = extractResponse(e)
  if (!resp) {
    // Sem response: network/timeout (só dá pra afirmar em AxiosError cru).
    return axios.isAxiosError(e)
  }
  const status = resp.status
  // 429 Too Many Requests (rate limit), 5xx servidor, 408 timeout
  if (status === 429 || status === 408) return true
  if (status >= 500 && status < 600)    return true
  // gpt-image-1 às vezes devolve 401 "Not authorized" com type=server_error:
  // é HICCUP de servidor da OpenAI disfarçado de 401 (a chave está OK), não
  // auth real. Auth real (chave inválida) vem com type=invalid_request_error
  // / code=invalid_api_key → NÃO bate aqui e continua falhando rápido.
  if (status === 401 && bodyIsServerError(resp.data)) return true
  return false
}

/** Extrai {status,data} de um AxiosError OU de um Error enriquecido com
 *  `.response` anexado (padrão do LlmService.enrichAxiosError). */
function extractResponse(e: unknown): { status: number; data?: unknown } | null {
  if (axios.isAxiosError(e)) {
    const ax = e as AxiosError
    return ax.response ? { status: ax.response.status, data: ax.response.data } : null
  }
  const anyE = e as { response?: { status?: number; data?: unknown } }
  if (anyE?.response && typeof anyE.response.status === 'number') {
    return { status: anyE.response.status, data: anyE.response.data }
  }
  return null
}

/** O corpo do erro indica erro de servidor (transitório)? Cobre o body como
 *  objeto ({error:{type:'server_error'}}) ou já serializado em string. */
function bodyIsServerError(data: unknown): boolean {
  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data ?? '')
    return /server_error/i.test(s) || /not authorized/i.test(s)
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
