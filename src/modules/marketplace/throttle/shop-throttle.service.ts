import { Injectable, Logger } from '@nestjs/common'

/** F18 F0.6 — Throttle in-memory por shop_id pra Shopee Open Platform.
 *
 *  Shopee rate-limit ~10 req/s POR LOJA (não global por app). Implementação:
 *  Map<key, Promise> serializa FIFO; cada call espera o anterior + intervalo
 *  mínimo (default 100ms = 10 req/s). Calls de shops DIFERENTES rodam em
 *  paralelo — só serializa dentro da mesma key.
 *
 *  Single-instance OK (Railway 1 réplica). Se virar cluster, migrar pra Redis
 *  com lock distribuído. Sem persistência intencional — restart limpa estado
 *  e Shopee respeita janela móvel.
 *
 *  Cleanup: chain orfã morre quando última promise resolve — sem leak (chains
 *  são GC'd automaticamente se referência única).
 *
 *  Uso:
 *    await throttle.run(`shop:${shopId}`, () => axios.get(url))
 */
@Injectable()
export class ShopThrottleService {
  private readonly logger = new Logger(ShopThrottleService.name)
  private chains = new Map<string, Promise<unknown>>()

  /** Intervalo mínimo entre calls da MESMA key. 100ms ≈ 10 req/s.
   *  Configurável via env SHOPEE_MIN_INTERVAL_MS pra ajuste fino. */
  private readonly minIntervalMs: number =
    Number(process.env.SHOPEE_MIN_INTERVAL_MS) || 100

  /** Serializa execução de `fn` por key, garantindo ≥ minIntervalMs entre
   *  calls consecutivos do MESMO key. Calls de keys distintas são paralelos. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(async () => {
      const start = Date.now()
      try {
        return await fn()
      } finally {
        const wait = this.minIntervalMs - (Date.now() - start)
        if (wait > 0) await sleep(wait)
      }
    })
    // Catch silencia rejection pra próxima chain não ficar amarrada num erro;
    // o resultado real é retornado abaixo com tipagem certa.
    this.chains.set(key, next.catch(() => undefined))
    return next as Promise<T>
  }

  /** Stats de debug — usado em /health ou query manual. */
  stats(): { activeKeys: number; intervalMs: number } {
    return { activeKeys: this.chains.size, intervalMs: this.minIntervalMs }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
