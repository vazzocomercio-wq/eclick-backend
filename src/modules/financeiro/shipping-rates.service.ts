import { Injectable, HttpException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

// ── tipos ────────────────────────────────────────────────────────────────────

export interface CreateShippingRateDto {
  platform?: string          // default 'mercadolivre'
  logistic_type?: string     // default 'self_service' (Flex)
  amount: number             // R$ por venda
  valid_from?: string        // 'YYYY-MM-DD' (default hoje)
  notes?: string | null
}
export type UpdateShippingRateDto = Partial<CreateShippingRateDto> & {
  valid_to?: string | null
  active?: boolean
}

export interface ShippingRateRow {
  id: string
  organization_id: string
  platform: string
  logistic_type: string
  amount: number
  valid_from: string
  valid_to: string | null
  active: boolean
  notes: string | null
  created_at: string
  updated_at: string
}

const COLS =
  'id, organization_id, platform, logistic_type, amount, valid_from, valid_to, active, notes, created_at, updated_at'

/** Tipos logísticos sugeridos no front (livre — não é enum no banco). */
export const SHIPPING_LOGISTIC_TYPES = [
  { value: 'self_service', label: 'Mercado Envios Flex' },
  { value: 'cross_docking', label: 'Mercado Envios (Coleta/Agência)' },
  { value: 'drop_off', label: 'Mercado Envios (Pontos)' },
  { value: 'custom', label: 'Outro' },
] as const

/**
 * Tarifas de frete que o vendedor paga POR FORA (não aparecem em API ML/MP).
 * Caso âncora: Flex (self_service) = R$ fixo por venda à transportadora.
 * Versionado por vigência: cada reajuste = nova linha; o pedido usa a tarifa
 * válida NA DATA DA VENDA. Consumido pelo motor de DRE (Fase 2) via getRateForDate.
 */
@Injectable()
export class ShippingRatesService {
  // ── CRUD ────────────────────────────────────────────────────────────────

  async list(
    orgId: string,
    opts: { platform?: string; logistic_type?: string; active?: boolean } = {},
  ): Promise<ShippingRateRow[]> {
    let q = supabaseAdmin
      .from('marketplace_shipping_rates')
      .select(COLS)
      .eq('organization_id', orgId)
      .order('platform', { ascending: true })
      .order('logistic_type', { ascending: true })
      .order('valid_from', { ascending: false })
    if (opts.platform) q = q.eq('platform', opts.platform)
    if (opts.logistic_type) q = q.eq('logistic_type', opts.logistic_type)
    if (opts.active !== undefined) q = q.eq('active', opts.active)
    const { data, error } = await q
    if (error) throw new HttpException(error.message, 500)
    return (data ?? []) as ShippingRateRow[]
  }

  /**
   * Cadastra uma tarifa. Se já existir tarifa VIGENTE (valid_to null, active)
   * pro mesmo platform+logistic_type, ela é FECHADA no dia anterior ao novo
   * valid_from — registrando o reajuste sem sobrepor vigências.
   */
  async create(orgId: string, dto: CreateShippingRateDto): Promise<ShippingRateRow> {
    if (!(dto.amount >= 0) || !Number.isFinite(dto.amount)) {
      throw new HttpException('amount inválido', 400)
    }
    const platform = (dto.platform ?? 'mercadolivre').trim()
    const logisticType = (dto.logistic_type ?? 'self_service').trim()
    const validFrom = dto.valid_from ?? new Date().toISOString().slice(0, 10)

    // Fecha a vigência anterior em aberto (reajuste): valid_to = validFrom − 1 dia.
    const dayBefore = new Date(`${validFrom}T00:00:00Z`)
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1)
    const prevEnd = dayBefore.toISOString().slice(0, 10)
    await supabaseAdmin
      .from('marketplace_shipping_rates')
      .update({ valid_to: prevEnd, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('platform', platform)
      .eq('logistic_type', logisticType)
      .eq('active', true)
      .is('valid_to', null)

    const { data, error } = await supabaseAdmin
      .from('marketplace_shipping_rates')
      .insert({
        organization_id: orgId,
        platform,
        logistic_type: logisticType,
        amount: dto.amount,
        valid_from: validFrom,
        valid_to: null,
        notes: dto.notes ?? null,
      })
      .select(COLS)
      .single()
    if (error) throw new HttpException(error.message, 500)
    return data as ShippingRateRow
  }

  async update(orgId: string, id: string, dto: UpdateShippingRateDto): Promise<ShippingRateRow> {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const k of ['platform', 'logistic_type', 'amount', 'valid_from', 'valid_to', 'active', 'notes'] as const) {
      if (dto[k] !== undefined) patch[k] = dto[k]
    }
    const { data, error } = await supabaseAdmin
      .from('marketplace_shipping_rates')
      .update(patch)
      .eq('organization_id', orgId)
      .eq('id', id)
      .select(COLS)
      .maybeSingle()
    if (error) throw new HttpException(error.message, 500)
    if (!data) throw new NotFoundException('Tarifa não encontrada')
    return data as ShippingRateRow
  }

  /** Soft-delete: preserva histórico p/ DRE de meses passados. */
  async remove(orgId: string, id: string): Promise<{ ok: true }> {
    const today = new Date().toISOString().slice(0, 10)
    const { error } = await supabaseAdmin
      .from('marketplace_shipping_rates')
      .update({ active: false, valid_to: today, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', id)
    if (error) throw new HttpException(error.message, 500)
    return { ok: true }
  }

  // ── Consumo pelo motor de DRE (Fase 2) ───────────────────────────────────

  /**
   * Tarifa vigente na DATA do pedido (R$ por venda). Retorna 0 se não houver
   * tarifa cadastrada pra aquele platform+logistic_type naquela data.
   */
  async getRateForDate(
    orgId: string,
    platform: string,
    logisticType: string,
    date: string, // 'YYYY-MM-DD'
  ): Promise<number> {
    const { data, error } = await supabaseAdmin
      .from('marketplace_shipping_rates')
      .select('amount, valid_from, valid_to')
      .eq('organization_id', orgId)
      .eq('platform', platform)
      .eq('logistic_type', logisticType)
      .eq('active', true)
      .lte('valid_from', date)
      .order('valid_from', { ascending: false })
    if (error) throw new HttpException(error.message, 500)
    for (const r of (data ?? []) as Array<{ amount: number; valid_from: string; valid_to: string | null }>) {
      if (r.valid_to && r.valid_to < date) continue
      return Number(r.amount)
    }
    return 0
  }
}
