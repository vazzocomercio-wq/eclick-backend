/**
 * Sentry init — guarded by env var SENTRY_DSN.
 *
 * Sem DSN setado, todas as funções viram no-op (sem erro, sem perf hit).
 * Quando o DSN for setado no Railway, automaticamente passa a reportar.
 *
 * Setup:
 *   1. Cria projeto NestJS no Sentry → copia o DSN
 *   2. Railway env: SENTRY_DSN=https://...@sentry.io/...
 *   3. Opcional: SENTRY_ENVIRONMENT=production|staging
 *   4. Opcional: SENTRY_TRACES_SAMPLE_RATE=0.1 (10% das requests rastreadas)
 *   5. Opcional: SENTRY_RELEASE=git-sha
 */

import * as Sentry from '@sentry/node'

let initialized = false

export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return false
  if (initialized) return true

  try {
    Sentry.init({
      dsn,
      environment:        process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production',
      release:            process.env.SENTRY_RELEASE,
      tracesSampleRate:   Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0'),
      // Não enviamos PII por default. Se quiser request bodies, set true via env.
      sendDefaultPii:     process.env.SENTRY_SEND_PII === 'true',
      // Filtra dados sensíveis em headers/cookies
      beforeSend(event) {
        if (event.request?.headers) {
          delete event.request.headers['authorization']
          delete event.request.headers['cookie']
          delete event.request.headers['x-api-key']
        }
        return event
      },
    })
    initialized = true
    return true
  } catch (e) {
    console.error('[sentry] init falhou:', (e as Error).message)
    return false
  }
}

/** Captura exceção manual com contexto adicional. */
export function captureException(err: unknown, ctx?: Record<string, unknown>): void {
  if (!initialized) return
  Sentry.captureException(err, ctx ? { extra: ctx } : undefined)
}

/** Adiciona breadcrumb (eventos prévios à exceção). */
export function addBreadcrumb(message: string, data?: Record<string, unknown>): void {
  if (!initialized) return
  Sentry.addBreadcrumb({ message, data, level: 'info' })
}

/** Pra setar user ou tag por request (em guards/middlewares). */
export function setUserContext(user: { id: string; orgId?: string | null }): void {
  if (!initialized) return
  Sentry.setUser({ id: user.id, ...(user.orgId ? { orgId: user.orgId } : {}) })
}

/** Force flush (útil em serverless / shutdowns). */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return
  try { await Sentry.flush(timeoutMs) } catch { /* ignore */ }
}

export const isSentryInitialized = (): boolean => initialized
