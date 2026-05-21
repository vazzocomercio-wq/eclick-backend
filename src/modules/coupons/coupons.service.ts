import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import type { Coupon, CouponApplied, CouponType } from './coupons.types'

@Injectable()
export class CouponsService {
  private readonly logger = new Logger(CouponsService.name)

  // ─ CRUD (admin) ─────────────────────────────────────────────

  async list(orgId: string): Promise<Coupon[]> {
    const { data, error } = await supabaseAdmin
      .from('coupons')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    if (error) throw new BadRequestException(error.message)
    return (data ?? []) as Coupon[]
  }

  async create(orgId: string, input: {
    code: string
    type: CouponType
    value: number
    min_order_cents?: number
    usage_limit?: number | null
    expires_at?: string | null
    description?: string | null
    active?: boolean
  }): Promise<Coupon> {
    const code = (input.code ?? '').trim().toUpperCase()
    if (code.length < 3 || code.length > 32) {
      throw new BadRequestException('Código deve ter entre 3 e 32 caracteres.')
    }
    if (input.type === 'percentage' && (input.value < 1 || input.value > 100)) {
      throw new BadRequestException('Percentual deve estar entre 1 e 100.')
    }
    if (input.type === 'fixed' && input.value < 0) {
      throw new BadRequestException('Valor fixo deve ser positivo.')
    }
    const { data, error } = await supabaseAdmin
      .from('coupons')
      .insert({
        organization_id: orgId,
        code, type: input.type, value: input.value,
        min_order_cents: input.min_order_cents ?? 0,
        usage_limit: input.usage_limit ?? null,
        expires_at: input.expires_at ?? null,
        description: input.description ?? null,
        active: input.active ?? true,
      })
      .select('*').single()
    if (error) {
      if (error.code === '23505') throw new BadRequestException('Esse código já existe na sua loja.')
      throw new BadRequestException(error.message)
    }
    return data as Coupon
  }

  async update(orgId: string, id: string, patch: Partial<Coupon>): Promise<Coupon> {
    // Permite só fields editaveis (nao toca code, organization_id, used_count)
    const allowed: Partial<Coupon> = {}
    if (patch.type !== undefined)            allowed.type = patch.type
    if (patch.value !== undefined)           allowed.value = patch.value
    if (patch.min_order_cents !== undefined) allowed.min_order_cents = patch.min_order_cents
    if (patch.usage_limit !== undefined)     allowed.usage_limit = patch.usage_limit
    if (patch.expires_at !== undefined)      allowed.expires_at = patch.expires_at
    if (patch.active !== undefined)          allowed.active = patch.active
    if (patch.description !== undefined)     allowed.description = patch.description
    const { data, error } = await supabaseAdmin
      .from('coupons')
      .update({ ...allowed, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*').single()
    if (error) throw new BadRequestException(error.message)
    if (!data) throw new NotFoundException('Cupom não encontrado.')
    return data as Coupon
  }

  async remove(orgId: string, id: string): Promise<void> {
    const { error } = await supabaseAdmin
      .from('coupons')
      .delete()
      .eq('organization_id', orgId)
      .eq('id', id)
    if (error) throw new BadRequestException(error.message)
  }

  // ─ Apply (public — chamado do carrinho) ─────────────────────

  /**
   * Valida um cupom contra um subtotal (em centavos) e retorna desconto
   * calculado. Nao incrementa used_count — isso e feito quando o pedido e
   * pago (via incrementUsage).
   */
  async apply(orgId: string, code: string, subtotalCents: number): Promise<CouponApplied> {
    const normalized = (code ?? '').trim().toUpperCase()
    if (!normalized) throw new BadRequestException('Informe um código de cupom.')

    const { data, error } = await supabaseAdmin
      .from('coupons')
      .select('*')
      .eq('organization_id', orgId)
      .ilike('code', normalized)
      .maybeSingle()
    if (error) throw new BadRequestException(error.message)
    if (!data) throw new NotFoundException('Cupom não encontrado.')

    const c = data as Coupon
    if (!c.active) throw new BadRequestException('Cupom desativado.')
    if (c.expires_at && new Date(c.expires_at) < new Date()) {
      throw new BadRequestException('Cupom expirado.')
    }
    if (c.usage_limit !== null && c.used_count >= c.usage_limit) {
      throw new BadRequestException('Cupom esgotado.')
    }
    if (c.min_order_cents > subtotalCents) {
      const min = (c.min_order_cents / 100).toFixed(2).replace('.', ',')
      throw new BadRequestException(`Pedido mínimo R$ ${min} para usar este cupom.`)
    }

    let discount = 0
    let freeShipping = false
    let message = ''
    if (c.type === 'percentage') {
      discount = Math.floor(subtotalCents * c.value / 100)
      message  = `${c.value}% de desconto aplicado.`
    } else if (c.type === 'fixed') {
      discount = Math.min(c.value, subtotalCents)
      message  = `Desconto de R$ ${(discount / 100).toFixed(2).replace('.', ',')} aplicado.`
    } else if (c.type === 'free_shipping') {
      freeShipping = true
      message      = 'Frete grátis aplicado.'
    }
    return {
      code: c.code,
      type: c.type,
      discount_cents: discount,
      free_shipping: freeShipping,
      message,
    }
  }

  /**
   * Incrementa used_count quando o pedido e efetivado.
   * Chamado pelo webhook de pagamento (Payments service).
   */
  async incrementUsage(orgId: string, code: string): Promise<void> {
    const normalized = (code ?? '').trim().toUpperCase()
    if (!normalized) return
    const { data: existing } = await supabaseAdmin
      .from('coupons')
      .select('id, used_count')
      .eq('organization_id', orgId)
      .ilike('code', normalized)
      .maybeSingle()
    if (!existing) return
    await supabaseAdmin
      .from('coupons')
      .update({ used_count: ((existing as { used_count: number }).used_count ?? 0) + 1, updated_at: new Date().toISOString() })
      .eq('id', (existing as { id: string }).id)
  }
}
