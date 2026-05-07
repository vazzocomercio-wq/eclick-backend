/** Validacao pre-apply de uma recomendacao.
 *
 *  Verifica em ordem:
 *   1. Status da recomendacao (approved/edited)
 *   2. Status da campanha (started/pending)
 *   3. Deadline_date nao expirou
 *   4. Preco dentro de min/max permitido
 *   5. Quantidade dentro de min/max
 *   6. Estoque suficiente
 *   7. Item ainda candidate ou pending (nao finished)
 *   8. Margem nao-negativa (warning se baixa)
 */

import { Injectable } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

export interface ValidationError {
  code:    string
  message: string
}

export interface ValidationWarning {
  code:    string
  message: string
}

export interface ValidationResult {
  recommendation_id: string
  is_valid:          boolean
  errors:            ValidationError[]
  warnings:          ValidationWarning[]
  // Snapshot dos dados validados (pra audit)
  ml_item_id?:       string
  ml_campaign_id?:   string
  ml_promotion_type?:string
  current_offer_id?: string
}

@Injectable()
export class MlCampaignsValidatorService {
  async validate(orgId: string, recommendationId: string): Promise<ValidationResult> {
    const errors:   ValidationError[]   = []
    const warnings: ValidationWarning[] = []

    // 1. Recomendacao
    const { data: rec } = await supabaseAdmin
      .from('ml_campaign_recommendations')
      .select(`
        *,
        ml_campaign_items!inner (
          id, ml_item_id, ml_campaign_id, ml_promotion_type, ml_offer_id,
          original_price, status, min_discounted_price, max_discounted_price,
          min_quantity, max_quantity, campaign_id, product_id
        )
      `)
      .eq('organization_id', orgId)
      .eq('id', recommendationId)
      .maybeSingle()

    if (!rec) {
      errors.push({ code: 'recommendation_not_found', message: 'Recomendação não encontrada' })
      return { recommendation_id: recommendationId, is_valid: false, errors, warnings }
    }

    const r = rec as any
    const item = r.ml_campaign_items

    if (!['approved', 'edited', 'auto_approved'].includes(r.status)) {
      errors.push({ code: 'invalid_status', message: `Status "${r.status}" não permite aplicação. Aprove primeiro.` })
    }

    // 2. Campanha
    const { data: campaign } = await supabaseAdmin
      .from('ml_campaigns')
      .select('status, deadline_date, finish_date')
      .eq('id', item.campaign_id)
      .maybeSingle()

    if (!campaign) {
      errors.push({ code: 'campaign_not_found', message: 'Campanha não encontrada' })
    } else {
      const c = campaign as { status: string; deadline_date: string | null; finish_date: string | null }
      if (!['started', 'pending'].includes(c.status)) {
        errors.push({ code: 'campaign_not_active', message: `Campanha está "${c.status}" — não permite adesão` })
      }
      if (c.deadline_date && new Date(c.deadline_date) < new Date()) {
        errors.push({ code: 'deadline_passed', message: `Prazo de adesão expirou em ${new Date(c.deadline_date).toLocaleDateString('pt-BR')}` })
      }
    }

    // 3. Item
    if (item.status === 'finished') {
      errors.push({ code: 'item_finished', message: 'Item já saiu da campanha' })
    }

    // 4. Preco dentro dos limites
    const price = r.recommended_price
    if (price == null) {
      errors.push({ code: 'no_price', message: 'Preço não definido na recomendação' })
    } else {
      if (item.min_discounted_price != null && price < item.min_discounted_price) {
        errors.push({
          code: 'price_below_min',
          message: `Preço R$ ${price.toFixed(2)} abaixo do mínimo R$ ${item.min_discounted_price.toFixed(2)}`,
        })
      }
      if (item.max_discounted_price != null && price > item.max_discounted_price) {
        errors.push({
          code: 'price_above_max',
          message: `Preço R$ ${price.toFixed(2)} acima do máximo R$ ${item.max_discounted_price.toFixed(2)}`,
        })
      }
    }

    // 5. Quantidade
    const qty = r.recommended_quantity
    if (qty != null) {
      if (item.min_quantity != null && qty < item.min_quantity) {
        errors.push({ code: 'qty_below_min', message: `Quantidade ${qty} abaixo do mínimo ${item.min_quantity}` })
      }
      if (item.max_quantity != null && qty > item.max_quantity) {
        errors.push({ code: 'qty_above_max', message: `Quantidade ${qty} acima do máximo ${item.max_quantity}` })
      }
    }

    // 6. Estoque (do produto interno se vinculado)
    if (item.product_id && qty != null) {
      const { data: p } = await supabaseAdmin
        .from('products')
        .select('stock')
        .eq('id', item.product_id)
        .maybeSingle()
      const stock = (p as { stock: number | null } | null)?.stock ?? 0
      if (stock < qty) {
        errors.push({ code: 'insufficient_stock', message: `Estoque ${stock} un insuficiente pra qty ${qty}` })
      } else if (stock < qty * 1.5) {
        warnings.push({ code: 'tight_stock', message: `Estoque ${stock} un — pouco buffer acima de qty ${qty}` })
      }
    }

    // 7. Margem warning
    const scenarios = r.scenarios as any
    const margin = scenarios?.competitive?.margin_pct ?? null
    if (margin != null && margin < 5 && margin >= 0) {
      warnings.push({ code: 'thin_margin', message: `Margem apertada: ${margin.toFixed(1)}%` })
    }

    return {
      recommendation_id:  recommendationId,
      is_valid:           errors.length === 0,
      errors,
      warnings,
      ml_item_id:         item.ml_item_id,
      ml_campaign_id:     item.ml_campaign_id,
      ml_promotion_type:  item.ml_promotion_type,
      current_offer_id:   item.ml_offer_id ?? undefined,
    }
  }

  /** Valida em batch — util pro wizard de apply (mostra preview). */
  async validateMany(orgId: string, recommendationIds: string[]): Promise<ValidationResult[]> {
    const results: ValidationResult[] = []
    for (const id of recommendationIds) {
      results.push(await this.validate(orgId, id))
    }
    return results
  }
}
