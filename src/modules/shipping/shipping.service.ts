import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import type { ShippingRule, ShippingQuote, ShippingKind } from './shipping.types'

/** Mapa simples CEP → UF (apenas o digito de centena). Aproximacao. */
const CEP_UF_RANGES: Array<[number, number, string]> = [
  [1000000, 19999999, 'SP'],
  [20000000, 28999999, 'RJ'],
  [29000000, 29999999, 'ES'],
  [30000000, 39999999, 'MG'],
  [40000000, 48999999, 'BA'],
  [49000000, 49999999, 'SE'],
  [50000000, 56999999, 'PE'],
  [57000000, 57999999, 'AL'],
  [58000000, 58999999, 'PB'],
  [59000000, 59999999, 'RN'],
  [60000000, 63999999, 'CE'],
  [64000000, 64999999, 'PI'],
  [65000000, 65999999, 'MA'],
  [66000000, 68899999, 'PA'],
  [68900000, 68999999, 'AP'],
  [69000000, 69299999, 'AM'],
  [69300000, 69399999, 'RR'],
  [69400000, 69899999, 'AM'],
  [69900000, 69999999, 'AC'],
  [70000000, 72799999, 'DF'],
  [72800000, 76799999, 'GO'],
  [76800000, 76999999, 'RO'],
  [77000000, 77999999, 'TO'],
  [78000000, 78899999, 'MT'],
  [79000000, 79999999, 'MS'],
  [80000000, 87999999, 'PR'],
  [88000000, 89999999, 'SC'],
  [90000000, 99999999, 'RS'],
]

function cepToUf(cep: string): string | null {
  const digits = cep.replace(/\D/g, '')
  if (digits.length < 5) return null
  const n = parseInt(digits.padEnd(8, '0'), 10)
  if (!Number.isFinite(n)) return null
  const r = CEP_UF_RANGES.find(([from, to]) => n >= from && n <= to)
  return r?.[2] ?? null
}

function cepToNumber(cep: string): number {
  return parseInt(cep.replace(/\D/g, '').padEnd(8, '0'), 10) || 0
}

@Injectable()
export class ShippingService {
  private readonly logger = new Logger(ShippingService.name)

  // ─ CRUD admin ────────────────────────────────────────────────

  async list(orgId: string): Promise<ShippingRule[]> {
    const { data, error } = await supabaseAdmin
      .from('shipping_rules')
      .select('*')
      .eq('organization_id', orgId)
      .order('priority', { ascending: true })
    if (error) throw new BadRequestException(error.message)
    return (data ?? []) as ShippingRule[]
  }

  async create(orgId: string, input: Partial<ShippingRule>): Promise<ShippingRule> {
    if (!input.kind) throw new BadRequestException('kind obrigatório')
    if (!input.name) throw new BadRequestException('name obrigatório')
    const { data, error } = await supabaseAdmin
      .from('shipping_rules')
      .insert({
        organization_id:    orgId,
        kind:               input.kind,
        name:               input.name,
        priority:           input.priority ?? 100,
        active:             input.active ?? true,
        price_cents:        input.price_cents ?? 0,
        percent_value:      input.percent_value ?? null,
        price_per_kg_cents: input.price_per_kg_cents ?? null,
        cep_from:           input.cep_from ?? null,
        cep_to:             input.cep_to ?? null,
        min_subtotal_cents: input.min_subtotal_cents ?? null,
        max_subtotal_cents: input.max_subtotal_cents ?? null,
        max_weight_kg:      input.max_weight_kg ?? null,
        state_codes:        input.state_codes ?? null,
        delivery_min_days:  input.delivery_min_days ?? null,
        delivery_max_days:  input.delivery_max_days ?? null,
      })
      .select('*').single()
    if (error) throw new BadRequestException(error.message)
    return data as ShippingRule
  }

  async update(orgId: string, id: string, patch: Partial<ShippingRule>): Promise<ShippingRule> {
    const { data, error } = await supabaseAdmin
      .from('shipping_rules')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*').single()
    if (error) throw new BadRequestException(error.message)
    if (!data) throw new NotFoundException('Regra não encontrada.')
    return data as ShippingRule
  }

  async remove(orgId: string, id: string): Promise<void> {
    const { error } = await supabaseAdmin
      .from('shipping_rules')
      .delete()
      .eq('organization_id', orgId)
      .eq('id', id)
    if (error) throw new BadRequestException(error.message)
  }

  // ─ Calculate (publico) ────────────────────────────────────────

  async calculate(orgId: string, input: {
    cep:           string
    subtotalCents: number
    weightKg?:     number
  }): Promise<ShippingQuote[]> {
    const { data, error } = await supabaseAdmin
      .from('shipping_rules')
      .select('*')
      .eq('organization_id', orgId)
      .eq('active', true)
      .order('priority', { ascending: true })
    if (error) {
      this.logger.error(`[shipping] list falhou: ${error.message}`)
      return []
    }
    const rules = (data ?? []) as ShippingRule[]
    const cepNum = cepToNumber(input.cep)
    const uf     = cepToUf(input.cep)
    const weight = input.weightKg ?? 0

    const quotes: ShippingQuote[] = []
    for (const r of rules) {
      // Filtros comuns
      if (r.min_subtotal_cents !== null && input.subtotalCents < r.min_subtotal_cents) continue
      if (r.max_subtotal_cents !== null && input.subtotalCents > r.max_subtotal_cents) continue
      if (r.max_weight_kg !== null && weight > Number(r.max_weight_kg)) continue
      if (r.state_codes && r.state_codes.length > 0 && uf && !r.state_codes.includes(uf)) continue

      let price = 0
      switch (r.kind) {
        case 'fixed':
          price = r.price_cents
          break
        case 'free':
          price = 0
          break
        case 'percentage':
          price = Math.floor(input.subtotalCents * (Number(r.percent_value ?? 0) / 100))
          break
        case 'cep_range': {
          const from = r.cep_from ? cepToNumber(r.cep_from) : 0
          const to   = r.cep_to   ? cepToNumber(r.cep_to)   : 99999999
          if (cepNum < from || cepNum > to) continue
          price = r.price_cents
          break
        }
        case 'weight_based':
          price = Math.ceil(weight * (r.price_per_kg_cents ?? 0))
          break
        case 'melhor_envio':
          // TODO: integração real com Melhor Envio API. Por ora, skip.
          continue
      }

      quotes.push({
        rule_id:           r.id,
        name:              r.name,
        price_cents:       price,
        delivery_min_days: r.delivery_min_days,
        delivery_max_days: r.delivery_max_days,
        kind:              r.kind,
      })
    }
    return quotes
  }
}
