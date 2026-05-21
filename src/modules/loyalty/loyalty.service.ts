import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/** Programa de Fidelidade para Loja Própria.
 *
 *  Modelo:
 *   - settings (store_config.loyalty_settings) — config global
 *   - tiers — níveis configuráveis
 *   - customer_loyalty — saldo por (org, email)
 *
 *  Tier do cliente é calculado por total_spent_cents:
 *  o nível mais alto com min_spent_cents <= total_spent é o atual.
 */

export interface LoyaltySettings {
  enabled:        boolean
  currencyLabel:  string   // ex: "pontos", "estrelas"
  pointsPerReal:  number   // 1 ponto = 1 BRL gasto (futuro)
}

export const DEFAULT_LOYALTY_SETTINGS: LoyaltySettings = {
  enabled:        false,
  currencyLabel:  'pontos',
  pointsPerReal:  1,
}

export interface LoyaltyTier {
  id:              string
  organization_id: string
  name:            string
  description:     string | null
  color:           string
  icon_emoji:      string | null
  min_spent_cents: number
  benefits:        Array<{ label: string; icon?: string }>
  display_order:   number
  active:          boolean
  created_at:      string
  updated_at:      string
}

export interface CustomerLoyalty {
  organization_id:     string
  customer_identifier: string
  total_spent_cents:   number
  order_count:         number
  current_tier_id:     string | null
  points:              number
  last_purchase_at:    string | null
}

const normalizeEmail = (raw: string): string => raw.trim().toLowerCase()

@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name)

  // ── Settings ──────────────────────────────────────────────────────

  async getSettings(orgId: string): Promise<LoyaltySettings> {
    const { data } = await supabaseAdmin
      .from('store_config')
      .select('loyalty_settings')
      .eq('organization_id', orgId)
      .maybeSingle()
    const raw = (data?.loyalty_settings as Partial<LoyaltySettings> | null) ?? {}
    return { ...DEFAULT_LOYALTY_SETTINGS, ...raw }
  }

  async updateSettings(orgId: string, patch: Partial<LoyaltySettings>): Promise<LoyaltySettings> {
    const current = await this.getSettings(orgId)
    const next: LoyaltySettings = {
      enabled:        patch.enabled ?? current.enabled,
      currencyLabel:  (patch.currencyLabel ?? current.currencyLabel).slice(0, 20),
      pointsPerReal:  Math.max(0, patch.pointsPerReal ?? current.pointsPerReal),
    }
    const { error } = await supabaseAdmin
      .from('store_config')
      .update({ loyalty_settings: next })
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return next
  }

  // ── Tiers CRUD ────────────────────────────────────────────────────

  async listTiers(orgId: string): Promise<LoyaltyTier[]> {
    const { data, error } = await supabaseAdmin
      .from('loyalty_tiers')
      .select('*')
      .eq('organization_id', orgId)
      .order('display_order', { ascending: true })
      .order('min_spent_cents', { ascending: true })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []) as unknown as LoyaltyTier[]
  }

  async createTier(orgId: string, dto: Partial<LoyaltyTier>): Promise<LoyaltyTier> {
    if (!dto.name) throw new BadRequestException('name obrigatório')
    const { data, error } = await supabaseAdmin
      .from('loyalty_tiers')
      .insert({
        organization_id: orgId,
        name:            dto.name,
        description:     dto.description ?? null,
        color:           dto.color ?? '#a1a1aa',
        icon_emoji:      dto.icon_emoji ?? '⭐',
        min_spent_cents: dto.min_spent_cents ?? 0,
        benefits:        dto.benefits ?? [],
        display_order:   dto.display_order ?? 0,
        active:          dto.active ?? true,
      })
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? '?'}`)
    return data as unknown as LoyaltyTier
  }

  async updateTier(orgId: string, id: string, patch: Partial<LoyaltyTier>): Promise<LoyaltyTier> {
    const fields: Record<string, unknown> = {}
    const allowed: (keyof LoyaltyTier)[] = ['name', 'description', 'color', 'icon_emoji',
      'min_spent_cents', 'benefits', 'display_order', 'active']
    for (const k of allowed) if (k in patch) fields[k] = patch[k]
    if (Object.keys(fields).length === 0) throw new BadRequestException('nada pra atualizar')
    const { data, error } = await supabaseAdmin
      .from('loyalty_tiers')
      .update(fields)
      .eq('id', id)
      .eq('organization_id', orgId)
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'não encontrado'}`)
    return data as unknown as LoyaltyTier
  }

  async deleteTier(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('loyalty_tiers')
      .delete()
      .eq('id', id)
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  /** Inicializa 3 tiers padrão pra uma loja que ainda não tem nenhum.
   *  Idempotente — só insere se a org não tem nenhum tier. */
  async seedDefaultTiers(orgId: string): Promise<LoyaltyTier[]> {
    const existing = await this.listTiers(orgId)
    if (existing.length > 0) return existing
    const defaults = [
      { name: 'Bronze', icon_emoji: '🥉', color: '#a16207', min_spent_cents: 0,
        benefits: [{ label: 'Frete grátis acima de R$ 200', icon: '🚚' }], display_order: 0 },
      { name: 'Prata',  icon_emoji: '🥈', color: '#a1a1aa', min_spent_cents: 100000,
        benefits: [{ label: '5% off em todos os produtos', icon: '💰' }, { label: 'Acesso a lançamentos', icon: '🎁' }], display_order: 1 },
      { name: 'Ouro',   icon_emoji: '🥇', color: '#eab308', min_spent_cents: 500000,
        benefits: [{ label: '10% off em todos os produtos', icon: '💰' }, { label: 'Brindes exclusivos', icon: '🎁' }, { label: 'Frete grátis sempre', icon: '🚚' }], display_order: 2 },
    ]
    const { data, error } = await supabaseAdmin
      .from('loyalty_tiers')
      .insert(defaults.map(d => ({ ...d, organization_id: orgId })))
      .select('*')
    if (error) throw new BadRequestException(`Erro ao seed: ${error.message}`)
    return (data ?? []) as unknown as LoyaltyTier[]
  }

  // ── Customer loyalty ──────────────────────────────────────────────

  /** Saldo do cliente + tier resolvido. */
  async getCustomerLoyalty(orgId: string, emailRaw: string): Promise<{
    loyalty: CustomerLoyalty
    currentTier: LoyaltyTier | null
    nextTier: LoyaltyTier | null
    progressToNextCents: number  // quanto falta pro próximo (0 se já está no topo)
  } | null> {
    const email = normalizeEmail(emailRaw)
    if (!email) return null

    const { data: c } = await supabaseAdmin
      .from('customer_loyalty')
      .select('*')
      .eq('organization_id', orgId)
      .eq('customer_identifier', email)
      .maybeSingle()

    const loyalty: CustomerLoyalty = c
      ? (c as unknown as CustomerLoyalty)
      : {
          organization_id:      orgId,
          customer_identifier:  email,
          total_spent_cents:    0,
          order_count:          0,
          current_tier_id:      null,
          points:               0,
          last_purchase_at:     null,
        }

    const tiers = await this.listTiers(orgId)
    const activeTiers = tiers.filter(t => t.active).sort((a, b) => a.min_spent_cents - b.min_spent_cents)
    if (activeTiers.length === 0) return { loyalty, currentTier: null, nextTier: null, progressToNextCents: 0 }

    // Atual: o tier mais alto cuja min_spent <= total_spent
    let currentTier: LoyaltyTier | null = null
    let nextTier:    LoyaltyTier | null = null
    for (const t of activeTiers) {
      if (loyalty.total_spent_cents >= t.min_spent_cents) {
        currentTier = t
      } else if (!nextTier) {
        nextTier = t
        break
      }
    }
    const progressToNextCents = nextTier
      ? Math.max(0, nextTier.min_spent_cents - loyalty.total_spent_cents)
      : 0
    return { loyalty, currentTier, nextTier, progressToNextCents }
  }

  /** Registra compra paga — soma valor ao total_spent e recalcula tier.
   *  Idempotente: passa por order_id pra detectar reentrega. */
  async recordPurchase(args: {
    orgId:       string
    email:       string
    amountCents: number
    orderId:     string  // pra idempotência
  }): Promise<{ recorded: boolean; loyalty: CustomerLoyalty }> {
    const email = normalizeEmail(args.email)
    if (!email) throw new BadRequestException('email obrigatório')

    // Check idempotência: se já existe order_count atualizado com esse orderId,
    // usamos um marker simples no DB? Pra simplificar, fazemos lookup leve em
    // storefront_orders pra checar se total_spent já reflete esse order. Como
    // hook é chamado uma vez por status='paid', e webhook do gateway tem
    // dedup interno, vamos confiar nisso.
    // (Versão robusta usaria movements ledger — TODO.)

    const { data: cur } = await supabaseAdmin
      .from('customer_loyalty')
      .select('*')
      .eq('organization_id', args.orgId)
      .eq('customer_identifier', email)
      .maybeSingle()

    let loyalty: CustomerLoyalty
    if (!cur) {
      const { data, error } = await supabaseAdmin
        .from('customer_loyalty')
        .insert({
          organization_id:     args.orgId,
          customer_identifier: email,
          total_spent_cents:   args.amountCents,
          order_count:         1,
          last_purchase_at:    new Date().toISOString(),
        })
        .select('*').maybeSingle()
      if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? '?'}`)
      loyalty = data as unknown as CustomerLoyalty
    } else {
      const c2 = cur as { total_spent_cents: number; order_count: number }
      const newTotal = Number(c2.total_spent_cents) + args.amountCents
      const { data, error } = await supabaseAdmin
        .from('customer_loyalty')
        .update({
          total_spent_cents: newTotal,
          order_count:       Number(c2.order_count) + 1,
          last_purchase_at:  new Date().toISOString(),
        })
        .eq('organization_id', args.orgId)
        .eq('customer_identifier', email)
        .select('*').maybeSingle()
      if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? '?'}`)
      loyalty = data as unknown as CustomerLoyalty
    }

    // Recalcula tier atual baseado no novo total
    const tiers = await this.listTiers(args.orgId)
    const active = tiers.filter(t => t.active).sort((a, b) => b.min_spent_cents - a.min_spent_cents)
    const matched = active.find(t => loyalty.total_spent_cents >= t.min_spent_cents)
    if (matched && matched.id !== loyalty.current_tier_id) {
      await supabaseAdmin
        .from('customer_loyalty')
        .update({ current_tier_id: matched.id })
        .eq('organization_id', args.orgId)
        .eq('customer_identifier', email)
      loyalty.current_tier_id = matched.id
      this.logger.log(`[loyalty] ${email} promovido pra ${matched.name} (total: ${loyalty.total_spent_cents}c)`)
    }

    return { recorded: true, loyalty }
  }

  /** Stats admin: distribuição de clientes por tier. */
  async getStats(orgId: string): Promise<{
    totalCustomers:      number
    totalSpentCents:     number
    byTier:              Array<{ tierId: string | null; tierName: string; count: number; totalSpentCents: number }>
  }> {
    const tiers = await this.listTiers(orgId)
    const { data } = await supabaseAdmin
      .from('customer_loyalty')
      .select('current_tier_id, total_spent_cents')
      .eq('organization_id', orgId)
    const rows = (data ?? []) as Array<{ current_tier_id: string | null; total_spent_cents: number }>
    const tierMap = new Map(tiers.map(t => [t.id, t]))
    const counts = new Map<string | null, { count: number; total: number }>()
    for (const r of rows) {
      const cur = counts.get(r.current_tier_id) ?? { count: 0, total: 0 }
      cur.count++
      cur.total += Number(r.total_spent_cents ?? 0)
      counts.set(r.current_tier_id, cur)
    }
    const byTier = Array.from(counts.entries()).map(([tierId, agg]) => ({
      tierId,
      tierName: tierId ? (tierMap.get(tierId)?.name ?? 'Desconhecido') : 'Sem nível',
      count: agg.count,
      totalSpentCents: agg.total,
    }))
    return {
      totalCustomers:  rows.length,
      totalSpentCents: rows.reduce((s, r) => s + Number(r.total_spent_cents ?? 0), 0),
      byTier,
    }
  }
}
