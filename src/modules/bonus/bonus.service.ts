import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/** Bônus & Brindes para Loja Própria.
 *
 *  3 tipos:
 *   - bogo               Comprou X qty de produto A → ganha gift_qty do mesmo A
 *   - free_above_value   Pedido >= min_subtotal → ganha gift_product
 *   - gift_with_product  Comprou X qty de A → ganha gift_qty de B
 */

export type BonusType = 'bogo' | 'free_above_value' | 'gift_with_product'

export interface BonusRule {
  id:                  string
  organization_id:     string
  name:                string
  description:         string | null
  type:                BonusType
  trigger_product_id:  string | null
  trigger_qty:         number
  min_subtotal_cents:  number
  gift_product_id:     string | null
  gift_qty:            number
  active:              boolean
  starts_at:           string | null
  ends_at:             string | null
  applied_count:       number
  created_at:          string
  updated_at:          string
}

export interface CartLineForEval {
  productId: string
  qty:       number
  price:     number   // preço já efetivo (com promoção aplicada)
}

export interface AppliedBonus {
  ruleId:        string
  ruleName:      string
  type:          BonusType
  giftProductId: string
  giftQty:       number
  // Linha extra a adicionar no carrinho com price=0
}

@Injectable()
export class BonusService {
  private readonly logger = new Logger(BonusService.name)

  // ── CRUD ───────────────────────────────────────────────────────────

  async list(orgId: string): Promise<BonusRule[]> {
    const { data, error } = await supabaseAdmin
      .from('bonus_rules')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []) as unknown as BonusRule[]
  }

  async create(orgId: string, dto: Partial<BonusRule>): Promise<BonusRule> {
    if (!dto.name)  throw new BadRequestException('name obrigatório')
    if (!dto.type)  throw new BadRequestException('type obrigatório')
    this.validateRule(dto)

    const { data, error } = await supabaseAdmin
      .from('bonus_rules')
      .insert({
        organization_id:    orgId,
        name:               dto.name,
        description:        dto.description ?? null,
        type:               dto.type,
        trigger_product_id: dto.trigger_product_id ?? null,
        trigger_qty:        dto.trigger_qty ?? 2,
        min_subtotal_cents: dto.min_subtotal_cents ?? 0,
        gift_product_id:    dto.gift_product_id ?? null,
        gift_qty:           dto.gift_qty ?? 1,
        active:             dto.active ?? true,
        starts_at:          dto.starts_at ?? null,
        ends_at:            dto.ends_at ?? null,
      })
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? '?'}`)
    return data as unknown as BonusRule
  }

  async update(orgId: string, id: string, patch: Partial<BonusRule>): Promise<BonusRule> {
    const fields: Record<string, unknown> = {}
    const allowed: (keyof BonusRule)[] = [
      'name', 'description', 'type', 'trigger_product_id', 'trigger_qty',
      'min_subtotal_cents', 'gift_product_id', 'gift_qty', 'active',
      'starts_at', 'ends_at',
    ]
    for (const k of allowed) if (k in patch) fields[k] = patch[k]
    if (Object.keys(fields).length === 0) throw new BadRequestException('nada pra atualizar')
    if (patch.type) this.validateRule({ ...patch, type: patch.type })

    const { data, error } = await supabaseAdmin
      .from('bonus_rules')
      .update(fields)
      .eq('id', id)
      .eq('organization_id', orgId)
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'regra não encontrada'}`)
    return data as unknown as BonusRule
  }

  async remove(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('bonus_rules')
      .delete()
      .eq('id', id)
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  // ── Aplicação no carrinho ──────────────────────────────────────────

  /** Avalia regras ATIVAS e retorna lista de bônus aplicáveis ao
   *  carrinho. NÃO modifica o carrinho — só calcula. Chamado por
   *  payments.service.revalidateItems pra injetar as linhas grátis. */
  async evaluateCart(orgId: string, lines: CartLineForEval[]): Promise<AppliedBonus[]> {
    const nowIso = new Date().toISOString()
    const { data: rulesRaw } = await supabaseAdmin
      .from('bonus_rules')
      .select('*')
      .eq('organization_id', orgId)
      .eq('active', true)
      .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
      .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
    const rules = (rulesRaw ?? []) as unknown as BonusRule[]
    if (rules.length === 0) return []

    const subtotalCents = Math.round(lines.reduce((s, l) => s + l.price * l.qty * 100, 0))
    const applied: AppliedBonus[] = []

    for (const rule of rules) {
      const result = this.applyRule(rule, lines, subtotalCents)
      if (result) applied.push(result)
    }
    return applied
  }

  /** Incrementa contador de uso (chamado quando pedido é finalizado). */
  async incrementApplied(orgId: string, ruleId: string): Promise<void> {
    // RPC-like: SELECT current → UPDATE +1 (sem transação porque é stats)
    const { data: cur } = await supabaseAdmin
      .from('bonus_rules')
      .select('applied_count')
      .eq('id', ruleId).eq('organization_id', orgId)
      .maybeSingle()
    if (!cur) return
    await supabaseAdmin
      .from('bonus_rules')
      .update({ applied_count: Number((cur as { applied_count: number }).applied_count ?? 0) + 1 })
      .eq('id', ruleId)
      .eq('organization_id', orgId)
  }

  // ── Helpers privados ───────────────────────────────────────────────

  private applyRule(rule: BonusRule, lines: CartLineForEval[], subtotalCents: number): AppliedBonus | null {
    switch (rule.type) {
      case 'bogo': {
        if (!rule.trigger_product_id) return null
        const triggerLine = lines.find(l => l.productId === rule.trigger_product_id)
        if (!triggerLine) return null
        // Quantas vezes a regra aplica? Cliente compra trigger_qty → ganha gift_qty.
        // Ex: trigger=2 gift=1. Comprou 5 → aplica 2 vezes (4 pagos + 2 grátis,
        // sobra 1 pago).
        const times = Math.floor(triggerLine.qty / rule.trigger_qty)
        if (times <= 0) return null
        return {
          ruleId:        rule.id,
          ruleName:      rule.name,
          type:          'bogo',
          giftProductId: rule.trigger_product_id,  // BOGO: o brinde é o próprio produto
          giftQty:       times * rule.gift_qty,
        }
      }
      case 'free_above_value': {
        if (!rule.gift_product_id) return null
        if (subtotalCents < (rule.min_subtotal_cents ?? 0)) return null
        return {
          ruleId:        rule.id,
          ruleName:      rule.name,
          type:          'free_above_value',
          giftProductId: rule.gift_product_id,
          giftQty:       rule.gift_qty,
        }
      }
      case 'gift_with_product': {
        if (!rule.trigger_product_id || !rule.gift_product_id) return null
        const triggerLine = lines.find(l => l.productId === rule.trigger_product_id)
        if (!triggerLine || triggerLine.qty < rule.trigger_qty) return null
        return {
          ruleId:        rule.id,
          ruleName:      rule.name,
          type:          'gift_with_product',
          giftProductId: rule.gift_product_id,
          giftQty:       rule.gift_qty,
        }
      }
    }
  }

  private validateRule(dto: Partial<BonusRule>): void {
    switch (dto.type) {
      case 'bogo':
        if (!dto.trigger_product_id) throw new BadRequestException('BOGO precisa trigger_product_id')
        if ((dto.trigger_qty ?? 0) < 1) throw new BadRequestException('trigger_qty >= 1')
        break
      case 'free_above_value':
        if (!dto.gift_product_id) throw new BadRequestException('Brinde precisa gift_product_id')
        if ((dto.min_subtotal_cents ?? 0) <= 0) throw new BadRequestException('min_subtotal_cents > 0')
        break
      case 'gift_with_product':
        if (!dto.trigger_product_id) throw new BadRequestException('Brinde precisa trigger_product_id')
        if (!dto.gift_product_id)    throw new BadRequestException('Brinde precisa gift_product_id')
        break
      default:
        throw new BadRequestException(`type inválido: ${dto.type}`)
    }
  }
}
