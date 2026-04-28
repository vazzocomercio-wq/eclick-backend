import { Injectable, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

export type SegmentField =
  | 'abc_curve' | 'churn_risk' | 'segment'
  | 'total_purchases' | 'purchase_count' | 'rfm_score' | 'avg_ticket'
  | 'last_purchase_days' | 'has_cpf' | 'is_vip'

export type SegmentOperator =
  | 'eq' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'not_in'

export interface SegmentRule {
  field:    SegmentField
  operator: SegmentOperator
  value:    unknown
}

/** Avalia rules contra unified_customers e retorna ids casados.
 * Multiple rules → AND. Field "last_purchase_days" derivado de
 * last_purchase_at. "has_cpf" → cpf IS NOT NULL. "is_vip" → tags @>
 * ['vip']. Operators in/not_in → array de valores. */
@Injectable()
export class SegmentEvaluatorService {
  async matchCustomerIds(orgId: string, rules: SegmentRule[]): Promise<string[]> {
    let q = supabaseAdmin
      .from('unified_customers')
      .select('id')
      .eq('organization_id', orgId)

    for (const rule of rules) {
      q = this.applyRule(q, rule)
    }

    const { data, error } = await q.limit(50_000)
    if (error) throw new BadRequestException(`segment query falhou: ${error.message}`)
    return (data ?? []).map(r => r.id as string)
  }

  /** Conta sem materializar a lista (uso: preview "X clientes correspondem"). */
  async matchCount(orgId: string, rules: SegmentRule[]): Promise<number> {
    let q = supabaseAdmin
      .from('unified_customers')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)

    for (const rule of rules) {
      q = this.applyRule(q, rule)
    }

    const { count, error } = await q
    if (error) throw new BadRequestException(`segment count falhou: ${error.message}`)
    return count ?? 0
  }

  // ── private ─────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private applyRule(q: any, rule: SegmentRule): any {
    const { field, operator, value } = rule

    // Campos especiais
    if (field === 'has_cpf') {
      return value ? q.not('cpf', 'is', null) : q.is('cpf', null)
    }
    if (field === 'is_vip') {
      return value ? q.contains('tags', ['vip']) : q.not('tags', 'cs', '{vip}')
    }
    if (field === 'last_purchase_days') {
      const days = Number(value)
      if (!Number.isFinite(days)) throw new BadRequestException('last_purchase_days requer número')
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
      // operator interpretado em termos de last_purchase_at:
      //   lt N dias atrás = compra MAIS recente que cutoff = last_purchase_at >= cutoff
      switch (operator) {
        case 'lt':
        case 'lte': return q.gte('last_purchase_at', cutoff)
        case 'gt':
        case 'gte': return q.lte('last_purchase_at', cutoff)
        case 'eq':  return q.gte('last_purchase_at', new Date(Date.now() - (days + 1) * 86_400_000).toISOString())
                            .lte('last_purchase_at', cutoff)
        default:    throw new BadRequestException(`operator ${operator} não suportado para last_purchase_days`)
      }
    }

    // Campos diretos da tabela
    const direct: Record<string, string> = {
      abc_curve:       'abc_curve',
      churn_risk:      'churn_risk',
      segment:         'segment',
      total_purchases: 'total_purchases',
      purchase_count:  'purchase_count',
      rfm_score:       'rfm_score',
      avg_ticket:      'avg_ticket',
    }
    const col = direct[field]
    if (!col) throw new BadRequestException(`field "${field}" desconhecido`)

    switch (operator) {
      case 'eq':  return q.eq(col, value)
      case 'gt':  return q.gt(col, value)
      case 'lt':  return q.lt(col, value)
      case 'gte': return q.gte(col, value)
      case 'lte': return q.lte(col, value)
      case 'in': {
        if (!Array.isArray(value)) throw new BadRequestException(`operator "in" requer array em "${field}"`)
        return q.in(col, value)
      }
      case 'not_in': {
        if (!Array.isArray(value)) throw new BadRequestException(`operator "not_in" requer array em "${field}"`)
        return q.not(col, 'in', `(${value.map(v => String(v)).join(',')})`)
      }
      default: throw new BadRequestException(`operator "${operator}" não suportado`)
    }
  }
}
