/**
 * Estado de SLA pós-venda. Thresholds em horas úteis (08-18 SP, seg-sex).
 * 24h = SLA do ML pra exclusão de reclamação. A partir de 24h, o estado
 * é 'critical' e o lojista perdeu o direito.
 */

export type SlaState = 'green' | 'yellow' | 'orange' | 'red' | 'critical' | 'resolved'

export const SLA_THRESHOLDS = {
  yellow:   4,    // 4h úteis
  orange:   12,   // 12h úteis
  red:      20,   // 20h úteis
  critical: 24,   // 24h úteis = limite SLA do ML
} as const

/**
 * Calcula estado a partir de horas decorridas + se há resposta do vendedor.
 * - resolved: vendedor já respondeu (last_seller_message_at >= last_buyer_message_at)
 * - green:    < 4h úteis
 * - yellow:   4-11h úteis
 * - orange:   12-19h úteis
 * - red:      20-23h úteis (alerta operacional)
 * - critical: ≥ 24h úteis (SLA estourado)
 */
export function slaState(elapsedHours: number, hasResponse: boolean): SlaState {
  if (hasResponse)                              return 'resolved'
  if (elapsedHours < SLA_THRESHOLDS.yellow)     return 'green'
  if (elapsedHours < SLA_THRESHOLDS.orange)     return 'yellow'
  if (elapsedHours < SLA_THRESHOLDS.red)        return 'orange'
  if (elapsedHours < SLA_THRESHOLDS.critical)   return 'red'
  return 'critical'
}

/** Ordem pra ordenação no painel: critical primeiro, resolved último. */
export function slaPriority(state: SlaState): number {
  switch (state) {
    case 'critical': return 0
    case 'red':      return 1
    case 'orange':   return 2
    case 'yellow':   return 3
    case 'green':    return 4
    case 'resolved': return 5
  }
}
