/** Motivos pra PULAR a auditoria (determinísticos — não adianta retry). */
export type SkipReason = 'blocked_by_marketplace' | 'product_not_found' | 'product_unavailable'

/**
 * Lançado pelo scraper quando o anúncio não pode/não deve ser auditado
 * (esgotado/pausado/finalizado, bloqueado pelo marketplace, ou inexistente).
 * O worker captura via instanceof → marca o job como pulado (score=null +
 * skip_reason) SEM retry.
 */
export class GeoSkipError extends Error {
  constructor(public readonly skipReason: SkipReason, message?: string) {
    super(message ?? skipReason)
    this.name = 'GeoSkipError'
  }
}
