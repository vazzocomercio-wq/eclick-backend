/**
 * Regras puras de estoque, sem dependência de Nest/Supabase — ficam num
 * arquivo próprio pra o sync da Shopee usar sem criar ciclo de import com
 * o StockService (que já importa o serviço da Shopee).
 */

/**
 * Normaliza o estoque mínimo para pausa (unidades de estoque FÍSICO).
 *
 * COMPATIBILIDADE: a regra antiga de vitrine virtual gravava
 * `min_stock_to_pause = virtual_quantity` (ex.: 10.000 e 10.000) porque a
 * comparação era feita contra (físico + virtual). Com a comparação corrigida
 * (contra o físico livre), esse mesmo valor pausaria o catálogo inteiro.
 *
 * A migration 20260778 reescreve esses registros para 0, mas o código NÃO pode
 * depender da ordem entre migration e deploy — se o backend subisse antes do
 * banco, todo anúncio pausava; se o banco fosse antes, produto sem estoque
 * ficaria vendendo. Reconhecer a assinatura antiga aqui elimina essa janela.
 *
 * Pode ser removida quando não existir mais nenhuma linha com
 * `min_stock_to_pause = virtual_quantity AND min_stock_to_pause > 0`.
 */
export function normalizeMinStock(minRaw: unknown, virtualQty: unknown): number {
  const min = Math.max(0, Math.round(Number(minRaw || 0)))
  const virtual = Math.round(Number(virtualQty || 0))
  if (min > 0 && min === virtual) return 0
  return min
}

/**
 * Decide o que vai pro canal quando a regra de vitrine virtual está ativa.
 * Fonte única pra ML, Shopee e TikTok — a paridade entre canais é requisito.
 *
 *  • qty publicada = físico livre + virtual (sem descontar segurança: num
 *    produto de vitrine virtual a segurança percentual não faz sentido)
 *  • pausa quando o FÍSICO LIVRE (físico − reservado) ≤ mínimo
 *  • mínimo 0 ⇒ pausa quando o físico zera
 */
export function applyVirtualStockRule(input: {
  physical: number
  virtual: number
  reserved: number
  minStock: unknown
  autoPause: boolean
}): { fisicoLivre: number; qty: number; pause: boolean; effectiveQty: number; min: number } {
  const virtual     = Math.max(0, Math.round(Number(input.virtual || 0)))
  const fisicoLivre = Math.max(0, Math.round(Number(input.physical || 0) - Number(input.reserved || 0)))
  const qty         = Math.max(0, fisicoLivre + virtual)
  const min         = normalizeMinStock(input.minStock, virtual)
  const pause       = !!input.autoPause && fisicoLivre <= min
  return { fisicoLivre, qty, pause, effectiveQty: pause ? 0 : qty, min }
}
