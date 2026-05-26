/**
 * Lógica PURA de consumo FIFO de lotes de cashback (sem I/O) — isolada aqui
 * pra ser testável sem puxar o supabase client do service.
 */

/** Aloca `amount` (centavos) sobre lotes JÁ ordenados em FIFO. Retorna quanto
 *  tirar de cada lote + `leftover` (> 0 quando os lotes não cobrem o valor —
 *  indica lote legado sem remaining ou drift; não deve acontecer pós-backfill). */
export function allocateFifo(
  lots: Array<{ id: string; remaining: number }>,
  amount: number,
): { takes: Array<{ id: string; take: number }>; leftover: number } {
  let left = Math.max(0, Math.floor(amount))
  const takes: Array<{ id: string; take: number }> = []
  for (const lot of lots) {
    if (left <= 0) break
    const avail = Math.max(0, Math.floor(lot.remaining))
    if (avail <= 0) continue
    const take = Math.min(left, avail)
    takes.push({ id: lot.id, take })
    left -= take
  }
  return { takes, leftover: left }
}
