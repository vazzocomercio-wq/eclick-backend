import { Injectable } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { BaseAnalyzer } from './base.analyzer'
import type { AnalyzerName, SignalDraft } from './analyzers.types'

const ATRASO_DIAS_CRITICAL = 7    // > 7 dias atrasada → critical
const CHEGANDO_DIAS_AHEAD  = 3    // expected nas próximas 3 dias → info

const SIGNAL_TTL_HOURS = 24

interface PORow {
  id:                    string
  po_number:             string | null
  status:                string
  expected_arrival_date: string | null
  total_cost:            number | null
  supplier_id:           string | null
}

/**
 * ComprasAnalyzer — monitora purchase_orders abertas.
 *
 * Categorias:
 *   po_atrasada_critica   — atrasada > 7d, status in_transit/pending  (critical, score 90)
 *   po_atrasada           — atrasada 1-7d                              (warning,  score 60)
 *   po_chegando           — expected_arrival nos próximos 3 dias       (info,     score 35)
 */
@Injectable()
export class ComprasAnalyzer extends BaseAnalyzer {
  readonly name: AnalyzerName = 'compras'

  async scan(orgId: string): Promise<SignalDraft[]> {
    const { data, error } = await supabaseAdmin
      .from('purchase_orders')
      .select('id, po_number, status, expected_arrival_date, total_cost, supplier_id')
      .eq('organization_id', orgId)
      .in('status', ['draft', 'pending', 'approved', 'in_transit', 'shipped'])
    if (error) {
      this.logger.error(`[compras] org=${orgId} query: ${error.message}`)
      return []
    }

    const now = Date.now()
    const drafts: SignalDraft[] = []
    const expiresAt = new Date(now + SIGNAL_TTL_HOURS * 3_600_000).toISOString()

    for (const po of (data ?? []) as PORow[]) {
      if (!po.expected_arrival_date) continue
      const eta = new Date(po.expected_arrival_date).getTime()
      const diffDays = (now - eta) / 86_400_000  // positivo = atraso, negativo = chegando

      if (diffDays > ATRASO_DIAS_CRITICAL) {
        drafts.push(this.buildAtrasoCritico(po, Math.floor(diffDays), expiresAt))
      } else if (diffDays > 0) {
        drafts.push(this.buildAtraso(po, Math.floor(diffDays), expiresAt))
      } else if (diffDays >= -CHEGANDO_DIAS_AHEAD) {
        drafts.push(this.buildChegando(po, Math.abs(Math.ceil(diffDays)), expiresAt))
      }
    }

    this.logger.log(`[compras] org=${orgId} pos=${(data ?? []).length} signals=${drafts.length}`)
    return drafts
  }

  private label(po: PORow): string {
    return po.po_number ? `PO ${po.po_number}` : `PO ${po.id.slice(0, 8)}`
  }

  private buildAtrasoCritico(po: PORow, days: number, expiresAt: string): SignalDraft {
    return {
      analyzer:    this.name,
      category:    'po_atrasada_critica',
      severity:    'critical',
      score:       90,
      entity_type: 'order',
      entity_id:   po.id,
      entity_name: this.label(po),
      data: { days_late: days, status: po.status, total_cost: po.total_cost, supplier_id: po.supplier_id },
      summary_pt:  `${this.label(po)} está atrasada ${days} dias (status: ${po.status}, ETA: ${po.expected_arrival_date}).`,
      suggestion_pt: 'Contatar fornecedor urgentemente — pode haver problema na operação.',
      expires_at:  expiresAt,
    }
  }

  private buildAtraso(po: PORow, days: number, expiresAt: string): SignalDraft {
    const score = Math.max(40, 50 + days * 3)
    return {
      analyzer:    this.name,
      category:    'po_atrasada',
      severity:    'warning',
      score,
      entity_type: 'order',
      entity_id:   po.id,
      entity_name: this.label(po),
      data: { days_late: days, status: po.status, total_cost: po.total_cost, supplier_id: po.supplier_id },
      summary_pt:  `${this.label(po)} atrasada ${days} dia${days !== 1 ? 's' : ''} (status: ${po.status}).`,
      suggestion_pt: 'Confirmar tracking com fornecedor.',
      expires_at:  expiresAt,
    }
  }

  private buildChegando(po: PORow, daysAhead: number, expiresAt: string): SignalDraft {
    return {
      analyzer:    this.name,
      category:    'po_chegando',
      severity:    'info',
      score:       35,
      entity_type: 'order',
      entity_id:   po.id,
      entity_name: this.label(po),
      data: { days_ahead: daysAhead, status: po.status, total_cost: po.total_cost, supplier_id: po.supplier_id },
      summary_pt:  daysAhead === 0
        ? `${this.label(po)} chega hoje.`
        : `${this.label(po)} chega em ${daysAhead} dia${daysAhead !== 1 ? 's' : ''}.`,
      suggestion_pt: 'Preparar recebimento e conferência.',
      expires_at:  expiresAt,
    }
  }
}
