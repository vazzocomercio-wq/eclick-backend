import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/** Cashback inteligente para Loja Própria.
 *
 *  Modelo:
 *   - balance: saldo agregado por (org, email)
 *   - movements: ledger imutável com idempotência via source_id
 *
 *  Identificador do cliente é email lowercase (vitrine não tem auth ainda).
 *  Quando criarmos customer_id próprio, migrar via UPDATE com lookup.
 */

export interface CashbackSettings {
  enabled:                  boolean
  earnPct:                  number    // 0..15 — % do total do pedido que vira saldo
  expirationDays:           number    // 0..365 — janela de validade; 0 = sem expiração
  minBalanceToUseCents:     number    // mínimo de saldo (em centavos) pra poder usar
  maxRedemptionPctPerOrder: number    // 0..100 — % máx do pedido pagável com cashback
  earnDelay:                'immediate' | 'after_delivery' | 'after_7_days'
}

export const DEFAULT_CASHBACK_SETTINGS: CashbackSettings = {
  enabled:                  false,
  earnPct:                  3,
  expirationDays:           90,
  minBalanceToUseCents:     500,
  maxRedemptionPctPerOrder: 50,
  earnDelay:                'immediate',
}

export interface CashbackBalance {
  organization_id:     string
  customer_identifier: string
  balance_cents:       number
  total_earned_cents:  number
  total_redeemed_cents: number
  last_movement_at:    string | null
}

export interface CashbackMovement {
  id:                  string
  organization_id:     string
  customer_identifier: string
  type:                'earn' | 'redeem' | 'expire' | 'adjustment'
  amount_cents:        number
  reason:              string | null
  source_kind:         string | null
  source_id:           string | null
  expires_at:          string | null
  created_at:          string
}

const normalizeEmail = (raw: string): string => raw.trim().toLowerCase()

@Injectable()
export class CashbackService {
  private readonly logger = new Logger(CashbackService.name)

  // ── Settings ────────────────────────────────────────────────────────

  /** Lê settings da loja. Retorna defaults quando NULL/inexistente. */
  async getSettings(orgId: string): Promise<CashbackSettings> {
    const { data, error } = await supabaseAdmin
      .from('store_config')
      .select('cashback_settings')
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    const raw = (data?.cashback_settings as Partial<CashbackSettings> | null) ?? {}
    return { ...DEFAULT_CASHBACK_SETTINGS, ...raw }
  }

  /** Atualiza settings. Sanitiza ranges e clampa valores fora do limite. */
  async updateSettings(orgId: string, patch: Partial<CashbackSettings>): Promise<CashbackSettings> {
    const current = await this.getSettings(orgId)
    const next: CashbackSettings = {
      enabled:                  patch.enabled ?? current.enabled,
      earnPct:                  clamp(patch.earnPct                  ?? current.earnPct,                  0,  15),
      expirationDays:           clamp(patch.expirationDays           ?? current.expirationDays,           0,  365),
      minBalanceToUseCents:     Math.max(0, patch.minBalanceToUseCents ?? current.minBalanceToUseCents),
      maxRedemptionPctPerOrder: clamp(patch.maxRedemptionPctPerOrder ?? current.maxRedemptionPctPerOrder, 0,  100),
      earnDelay:                (['immediate', 'after_delivery', 'after_7_days'] as const).includes(patch.earnDelay as never)
                                  ? (patch.earnDelay as CashbackSettings['earnDelay'])
                                  : current.earnDelay,
    }
    const { error } = await supabaseAdmin
      .from('store_config')
      .update({ cashback_settings: next })
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro ao salvar: ${error.message}`)
    return next
  }

  // ── Balance (consulta) ──────────────────────────────────────────────

  /** Saldo do cliente. Retorna 0 quando ainda não tem balance row. */
  async getBalance(orgId: string, emailRaw: string): Promise<CashbackBalance | null> {
    const email = normalizeEmail(emailRaw)
    if (!email) return null
    const { data, error } = await supabaseAdmin
      .from('customer_cashback_balances')
      .select('*')
      .eq('organization_id', orgId)
      .eq('customer_identifier', email)
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) {
      return {
        organization_id:      orgId,
        customer_identifier:  email,
        balance_cents:        0,
        total_earned_cents:   0,
        total_redeemed_cents: 0,
        last_movement_at:     null,
      }
    }
    return data as unknown as CashbackBalance
  }

  /** Histórico (paginado, ordem decrescente). */
  async listMovements(
    orgId: string,
    emailRaw: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<CashbackMovement[]> {
    const email = normalizeEmail(emailRaw)
    if (!email) return []
    const limit  = Math.min(opts.limit  ?? 50, 200)
    const offset = Math.max(opts.offset ?? 0, 0)
    const { data, error } = await supabaseAdmin
      .from('customer_cashback_movements')
      .select('*')
      .eq('organization_id', orgId)
      .eq('customer_identifier', email)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []) as unknown as CashbackMovement[]
  }

  // ── Operações ───────────────────────────────────────────────────────

  /** Credita cashback (positivo). Idempotente via source_id — webhook
   *  reentregue não credita 2x. Atualiza balance row. */
  async credit(args: {
    orgId:       string
    email:       string
    amountCents: number
    reason?:     string
    sourceKind?: string  // 'storefront_order', 'manual'
    sourceId?:   string  // UUID do pedido
    expiresAt?:  string | null
  }): Promise<{ credited: boolean; balance: CashbackBalance }> {
    if (args.amountCents <= 0) throw new BadRequestException('amountCents deve ser > 0')
    const email = normalizeEmail(args.email)
    if (!email) throw new BadRequestException('email obrigatório')

    // Cria movement (UNIQUE em source_id previne duplicação)
    const { data: mv, error: mvErr } = await supabaseAdmin
      .from('customer_cashback_movements')
      .insert({
        organization_id:      args.orgId,
        customer_identifier:  email,
        type:                 'earn',
        amount_cents:         args.amountCents,
        reason:               args.reason ?? null,
        source_kind:          args.sourceKind ?? null,
        source_id:            args.sourceId ?? null,
        expires_at:           args.expiresAt ?? null,
      })
      .select('*')
      .maybeSingle()

    if (mvErr) {
      // duplicate key (23505) = já creditado. NÃO é erro — apenas skip.
      const code = (mvErr as { code?: string }).code
      if (code === '23505') {
        this.logger.log(`[cashback.credit] já creditado pra source_id=${args.sourceId}`)
        const bal = await this.upsertBalance(args.orgId, email, 0, 0)
        return { credited: false, balance: bal }
      }
      throw new BadRequestException(`Erro: ${mvErr.message}`)
    }

    // Atualiza balance
    const balance = await this.upsertBalance(args.orgId, email, args.amountCents, args.amountCents, 0, mv?.created_at as string | null)
    this.logger.log(`[cashback.credit] +${args.amountCents}c em ${email} (org=${args.orgId})`)
    return { credited: true, balance }
  }

  /** Debita cashback (resgate). Valida saldo suficiente. */
  async redeem(args: {
    orgId:       string
    email:       string
    amountCents: number
    reason?:     string
    sourceKind?: string
    sourceId?:   string
  }): Promise<{ redeemed: boolean; balance: CashbackBalance }> {
    if (args.amountCents <= 0) throw new BadRequestException('amountCents deve ser > 0')
    const email = normalizeEmail(args.email)
    if (!email) throw new BadRequestException('email obrigatório')

    const balance = await this.getBalance(args.orgId, email)
    if (!balance || balance.balance_cents < args.amountCents) {
      throw new BadRequestException('Saldo insuficiente')
    }

    const { error: mvErr } = await supabaseAdmin
      .from('customer_cashback_movements')
      .insert({
        organization_id:      args.orgId,
        customer_identifier:  email,
        type:                 'redeem',
        amount_cents:         -args.amountCents,
        reason:               args.reason ?? null,
        source_kind:          args.sourceKind ?? null,
        source_id:            args.sourceId ?? null,
      })

    if (mvErr) {
      const code = (mvErr as { code?: string }).code
      if (code === '23505') {
        // Já debitado — retorna idempotente
        const cur = await this.getBalance(args.orgId, email)
        return { redeemed: false, balance: cur! }
      }
      throw new BadRequestException(`Erro: ${mvErr.message}`)
    }

    const updated = await this.upsertBalance(args.orgId, email, -args.amountCents, 0, args.amountCents)
    this.logger.log(`[cashback.redeem] -${args.amountCents}c em ${email} (org=${args.orgId})`)
    return { redeemed: true, balance: updated }
  }

  /** Calcula quanto pode ser usado num pedido dadas as regras
   *  (maxRedemptionPctPerOrder + minBalanceToUseCents). */
  async previewRedemption(orgId: string, email: string, orderTotalCents: number): Promise<{
    maxRedeemableCents: number
    balance:            number
    enabled:            boolean
  }> {
    const settings = await this.getSettings(orgId)
    const balance  = await this.getBalance(orgId, email)
    if (!settings.enabled) {
      return { maxRedeemableCents: 0, balance: balance?.balance_cents ?? 0, enabled: false }
    }
    const balanceCents = balance?.balance_cents ?? 0
    if (balanceCents < settings.minBalanceToUseCents) {
      return { maxRedeemableCents: 0, balance: balanceCents, enabled: true }
    }
    const capByPct = Math.floor((orderTotalCents * settings.maxRedemptionPctPerOrder) / 100)
    return {
      maxRedeemableCents: Math.min(balanceCents, capByPct),
      balance:            balanceCents,
      enabled:            true,
    }
  }

  // ── Expiração de saldos ────────────────────────────────────────────

  /** Cron diário: detecta earns expirados e cria expire movements.
   *  Idempotente — source_id=earn_movement_id previne re-expiração.
   *
   *  Lógica:
   *   1. Busca movements type='earn' com expires_at <= now()
   *   2. Pra cada um, verifica se já existe movement type='expire' com
   *      source_id apontando pra ele (idempotência)
   *   3. Se não, cria expire movement (-amount) + atualiza balance row
   *
   *  Conservativo: só expira earns que JÁ FORAM creditados (a coluna
   *  expires_at vem setada no INSERT do credit). Não toca em valores
   *  que vieram de redeem/adjustment. */
  async expireOldEarns(now = new Date()): Promise<{
    expiredCount: number
    expiredCents: number
  }> {
    const nowIso = now.toISOString()
    // Pega earns expirados (com expires_at não-NULL e passado)
    const { data: expired } = await supabaseAdmin
      .from('customer_cashback_movements')
      .select('id, organization_id, customer_identifier, amount_cents, expires_at')
      .eq('type', 'earn')
      .not('expires_at', 'is', null)
      .lte('expires_at', nowIso)
      .order('created_at', { ascending: true })
      .limit(5000)

    const rows = (expired ?? []) as Array<{
      id: string; organization_id: string; customer_identifier: string;
      amount_cents: number; expires_at: string;
    }>

    if (rows.length === 0) return { expiredCount: 0, expiredCents: 0 }

    // Idempotência: filtra fora os que já tiveram expire movement criado.
    const earnIds = rows.map(r => r.id)
    const { data: existing } = await supabaseAdmin
      .from('customer_cashback_movements')
      .select('source_id')
      .eq('type', 'expire')
      .eq('source_kind', 'cron_expire')
      .in('source_id', earnIds)

    const alreadyExpired = new Set(((existing ?? []) as Array<{ source_id: string }>).map(r => r.source_id))
    const toExpire = rows.filter(r => !alreadyExpired.has(r.id))

    if (toExpire.length === 0) return { expiredCount: 0, expiredCents: 0 }

    let totalCents = 0
    for (const earn of toExpire) {
      try {
        // Cria expire movement
        const { error: mvErr } = await supabaseAdmin
          .from('customer_cashback_movements')
          .insert({
            organization_id:      earn.organization_id,
            customer_identifier:  earn.customer_identifier,
            type:                 'expire',
            amount_cents:         -Number(earn.amount_cents),
            reason:               `Expirado em ${earn.expires_at.slice(0, 10)}`,
            source_kind:          'cron_expire',
            source_id:            earn.id,
          })
        if (mvErr) {
          const code = (mvErr as { code?: string }).code
          if (code === '23505') continue  // já expirado, race condition
          this.logger.warn(`[cashback.expire] mv failed: ${mvErr.message}`)
          continue
        }

        // Decrementa o balance — pode zerar mas não negativar
        const { data: bal } = await supabaseAdmin
          .from('customer_cashback_balances')
          .select('balance_cents')
          .eq('organization_id', earn.organization_id)
          .eq('customer_identifier', earn.customer_identifier)
          .maybeSingle()
        if (bal) {
          const newBalance = Math.max(0, Number((bal as { balance_cents: number }).balance_cents) - Number(earn.amount_cents))
          await supabaseAdmin
            .from('customer_cashback_balances')
            .update({ balance_cents: newBalance, last_movement_at: nowIso })
            .eq('organization_id', earn.organization_id)
            .eq('customer_identifier', earn.customer_identifier)
        }
        totalCents += Number(earn.amount_cents)
      } catch (err) {
        this.logger.warn(`[cashback.expire] earn=${earn.id} falhou: ${(err as Error).message}`)
      }
    }

    this.logger.log(`[cashback.expire] expirou ${toExpire.length} earns (${totalCents}c)`)
    return { expiredCount: toExpire.length, expiredCents: totalCents }
  }

  // ── Stats admin ─────────────────────────────────────────────────────

  async getStats(orgId: string): Promise<{
    totalInCirculationCents: number
    totalEarnedCents:        number
    totalRedeemedCents:      number
    activeCustomers:         number
  }> {
    const { data } = await supabaseAdmin
      .from('customer_cashback_balances')
      .select('balance_cents, total_earned_cents, total_redeemed_cents')
      .eq('organization_id', orgId)
    const rows = (data ?? []) as Array<{ balance_cents: number; total_earned_cents: number; total_redeemed_cents: number }>
    let circ = 0, earned = 0, redeemed = 0, active = 0
    for (const r of rows) {
      circ     += Number(r.balance_cents ?? 0)
      earned   += Number(r.total_earned_cents ?? 0)
      redeemed += Number(r.total_redeemed_cents ?? 0)
      if (Number(r.balance_cents) > 0) active++
    }
    return {
      totalInCirculationCents: circ,
      totalEarnedCents:        earned,
      totalRedeemedCents:      redeemed,
      activeCustomers:         active,
    }
  }

  // ── Helpers internos ────────────────────────────────────────────────

  private async upsertBalance(
    orgId: string,
    email: string,
    deltaBalance: number,
    deltaEarned: number,
    deltaRedeemed = 0,
    lastMovementAt: string | null = null,
  ): Promise<CashbackBalance> {
    // SELECT current row
    const { data: cur } = await supabaseAdmin
      .from('customer_cashback_balances')
      .select('*')
      .eq('organization_id', orgId)
      .eq('customer_identifier', email)
      .maybeSingle()

    if (!cur) {
      const { data, error } = await supabaseAdmin
        .from('customer_cashback_balances')
        .insert({
          organization_id:      orgId,
          customer_identifier:  email,
          balance_cents:        Math.max(0, deltaBalance),
          total_earned_cents:   Math.max(0, deltaEarned),
          total_redeemed_cents: Math.max(0, deltaRedeemed),
          last_movement_at:     lastMovementAt ?? new Date().toISOString(),
        })
        .select('*').maybeSingle()
      if (error || !data) throw new BadRequestException(`Erro ao criar balance: ${error?.message ?? '?'}`)
      return data as unknown as CashbackBalance
    }

    const newBalance  = Math.max(0, Number((cur as { balance_cents: number }).balance_cents)  + deltaBalance)
    const newEarned   = Math.max(0, Number((cur as { total_earned_cents: number }).total_earned_cents)   + deltaEarned)
    const newRedeemed = Math.max(0, Number((cur as { total_redeemed_cents: number }).total_redeemed_cents) + deltaRedeemed)

    const { data, error } = await supabaseAdmin
      .from('customer_cashback_balances')
      .update({
        balance_cents:        newBalance,
        total_earned_cents:   newEarned,
        total_redeemed_cents: newRedeemed,
        last_movement_at:     lastMovementAt ?? new Date().toISOString(),
      })
      .eq('organization_id', orgId)
      .eq('customer_identifier', email)
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao atualizar balance: ${error?.message ?? '?'}`)
    return data as unknown as CashbackBalance
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}
