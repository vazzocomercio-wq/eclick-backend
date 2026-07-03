import {
  CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'

/**
 * Rate-limit leve em memória pros endpoints PÚBLICOS da Loja Própria
 * (login/signup, checkout, cupom, lead, eventos). Sem dependência externa
 * (nada de @nestjs/throttler) — mapa em memória com janela fixa por IP.
 *
 * Uso:
 *   @UseGuards(RateLimitGuard)
 *   @RateLimit({ limit: 5, windowMs: 60_000, keyPrefix: 'sf-login' })
 *
 * Chave = keyPrefix + IP real. IP = primeiro valor do X-Forwarded-For
 * (Railway roda atrás de proxy — mesmo padrão do visualizer/leads), com
 * fallback pro remoteAddress do socket.
 *
 * ⚠️ NÃO aplicar em webhooks de pagamento nem nas rotas SSR de vitrine
 * (GET /public/store/by-slug/* — o SSR do Netlify concentra IPs e um
 * limite por IP derrubaria a loja inteira).
 */

export interface RateLimitOptions {
  /** Máximo de requisições dentro da janela. */
  limit: number
  /** Janela em milissegundos (ex: 60_000 = 1 min). */
  windowMs: number
  /** Prefixo da chave — separa contadores por rota. */
  keyPrefix: string
}

export const RATE_LIMIT_KEY = 'rate_limit_options'

/** Decorator de rota: define os limites que o RateLimitGuard aplica. */
export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options)

interface Bucket { count: number; resetAt: number }

// Estado compartilhado do processo (o guard é instanciado por rota, o mapa não)
const buckets = new Map<string, Bucket>()

// Limpeza periódica dos buckets expirados pra não vazar memória.
// unref() → o timer não segura o processo vivo no shutdown.
const CLEANUP_INTERVAL_MS = 60_000
const cleanupTimer = setInterval(() => {
  const now = Date.now()
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key)
  }
}, CLEANUP_INTERVAL_MS)
cleanupTimer.unref?.()

/** IP real do cliente: primeiro valor do X-Forwarded-For (atrás de proxy),
 *  senão o remoteAddress do socket. */
export function extractClientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for']
  const first = (Array.isArray(fwd) ? fwd[0] : (fwd ?? '')).toString().split(',')[0]?.trim()
  return first || req.socket?.remoteAddress || 'unknown'
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    )
    if (!options) return true // rota sem @RateLimit → não limita

    const req = context.switchToHttp().getRequest<Request>()
    const key = `${options.keyPrefix}:${extractClientIp(req)}`
    const now = Date.now()

    const bucket = buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs })
      return true
    }
    bucket.count += 1
    if (bucket.count > options.limit) {
      throw new HttpException(
        'Muitas requisições. Aguarde um instante e tente novamente.',
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }
    return true
  }
}
