import { Injectable, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/** Canais suportados (deve casar com o CHECK da tabela). */
export type Channel =
  | 'mercadolivre'
  | 'shopee'
  | 'amazon'
  | 'magalu'
  | 'tiktok_shop'
  | 'storefront'

const VALID_CHANNELS: ReadonlySet<Channel> = new Set([
  'mercadolivre', 'shopee', 'amazon', 'magalu', 'tiktok_shop', 'storefront',
])

export interface ChannelSetting {
  channel: Channel
  /** Take rate ESTIMADO da plataforma em % (0-100): comissão + serviço +
   *  transação + programas/frete-grátis. NÃO é só comissão. */
  estimated_take_rate_pct: number
  /** @deprecated Alias de `estimated_take_rate_pct` — mantido 1 ciclo de deploy
   *  p/ frontend antigo que ainda lê `commission_pct`. Será removido na Fase 2. */
  commission_pct: number
  commission_fixed: number
  notes: string | null
  updated_at: string | null
}

/** Shape cru da linha no banco (durante a transição, lê só a coluna nova). */
interface ChannelSettingRow {
  channel: Channel
  estimated_take_rate_pct: number
  commission_fixed: number
  notes: string | null
  updated_at: string | null
}

/** Mapeia a linha do banco → ChannelSetting, expondo o alias legado. */
function toSetting(r: ChannelSettingRow): ChannelSetting {
  const pct = Number(r.estimated_take_rate_pct) || 0
  return { ...r, estimated_take_rate_pct: pct, commission_pct: pct }
}

/** Regra de take rate por faixa de ticket/categoria (channel_fee_rules). */
export interface ChannelFeeRule {
  category_id:             string | null
  min_price:               number | null
  max_price:               number | null
  estimated_take_rate_pct: number
  fixed_fee:               number
}

/** Escolhe a regra mais ESPECÍFICA que casa com (price, categoryId) — função
 *  pura, pra callers em lote resolverem N itens sem N queries. Especificidade:
 *  categoria casada > genérica; entre faixas que casam, a mais estreita.
 *  Retorna null se nenhuma regra casa (caller cai no take achatado).
 *  ⚠️ Shopee cobra % + TAXA FIXA por unidade (tabela mar/2026) — a faixa é
 *  escolhida pelo preço UNITÁRIO do item, e a fixa multiplica a quantidade. */
export function pickRuleFee(
  rules: ChannelFeeRule[],
  price: number | null | undefined,
  categoryId?: string | null,
): { pct: number; fixed: number } | null {
  const p = Number(price)
  const matches = rules.filter(r => {
    if (r.category_id != null && r.category_id !== categoryId) return false
    if (!Number.isFinite(p)) return r.min_price == null && r.max_price == null
    if (r.min_price != null && p < r.min_price) return false
    if (r.max_price != null && p >= r.max_price) return false
    return true
  })
  if (!matches.length) return null
  matches.sort((a, b) => {
    // 1) categoria específica primeiro
    const cat = (b.category_id != null ? 1 : 0) - (a.category_id != null ? 1 : 0)
    if (cat !== 0) return cat
    // 2) faixa mais estreita primeiro
    const wa = (a.max_price ?? Infinity) - (a.min_price ?? 0)
    const wb = (b.max_price ?? Infinity) - (b.min_price ?? 0)
    return wa - wb
  })
  const pct = Number(matches[0].estimated_take_rate_pct)
  if (!Number.isFinite(pct)) return null
  return { pct, fixed: Number(matches[0].fixed_fee) || 0 }
}

/** Compat: só o % da regra (callers antigos). Prefira estimateSaleFee, que
 *  aplica também a taxa fixa por unidade. */
export function pickRuleTakeRate(
  rules: ChannelFeeRule[],
  price: number | null | undefined,
  categoryId?: string | null,
): number | null {
  return pickRuleFee(rules, price, categoryId)?.pct ?? null
}

/** Tarifa estimada em R$ de uma linha de venda: regra por faixa do preço
 *  UNITÁRIO (% sobre o total + fixa × quantidade); sem regra → % achatado. */
export function estimateSaleFee(
  rules: ChannelFeeRule[],
  unitPrice: number,
  qty: number,
  flatPct: number,
  categoryId?: string | null,
): number {
  const q = Math.max(1, Number(qty) || 1)
  const total = unitPrice * q
  const rule = pickRuleFee(rules, unitPrice, categoryId)
  if (!rule) return Math.round(total * flatPct / 100 * 100) / 100
  return Math.round((total * rule.pct / 100 + rule.fixed * q) * 100) / 100
}

/** Take efetivo (%) de 1 unidade a um dado preço — pra motores que trabalham
 *  em % (margem de campanha): converte % + fixa no equivalente percentual. */
export function effectiveTakePct(
  rules: ChannelFeeRule[],
  unitPrice: number,
  flatPct: number,
  categoryId?: string | null,
): number {
  if (!(unitPrice > 0)) return flatPct
  const fee = estimateSaleFee(rules, unitPrice, 1, flatPct, categoryId)
  return Math.round(fee / unitPrice * 10000) / 100
}

/** Custos por canal (org × canal) — take rate estimado %, taxa fixa, etc.
 *  Fonte da estimativa do platform_fee dos pedidos quando a API do canal NÃO
 *  devolve a taxa real no order (caso TikTok — só vem em Statements; Shopee — só
 *  no escrow pós-entrega). Cada canal tem seu take distinto; tratado de forma
 *  uniforme. A verdade PÓS-venda vem do ledger real (platform_charges). */
@Injectable()
export class ChannelSettingsService {
  /** Lê a config de UM canal pra org (ou null se nunca foi configurada). */
  async get(orgId: string, channel: Channel): Promise<ChannelSetting | null> {
    this.assertChannel(channel)
    const { data } = await supabaseAdmin
      .from('org_channel_settings')
      .select('channel, estimated_take_rate_pct, commission_fixed, notes, updated_at')
      .eq('organization_id', orgId)
      .eq('channel', channel)
      .maybeSingle<ChannelSettingRow>()
    return data ? toSetting(data) : null
  }

  /** Lê TODOS os canais configurados pra org (lista pra UI de configurações). */
  async listForOrg(orgId: string): Promise<ChannelSetting[]> {
    const { data } = await supabaseAdmin
      .from('org_channel_settings')
      .select('channel, estimated_take_rate_pct, commission_fixed, notes, updated_at')
      .eq('organization_id', orgId)
      .order('channel', { ascending: true })
    return ((data ?? []) as ChannelSettingRow[]).map(toSetting)
  }

  /** Upsert da config de UM canal pra org. Aceita o nome novo
   *  (`estimated_take_rate_pct`) e o legado (`commission_pct`). */
  async upsert(
    orgId: string,
    channel: Channel,
    patch: { estimated_take_rate_pct?: number; commission_pct?: number; commission_fixed?: number; notes?: string | null },
  ): Promise<ChannelSetting> {
    this.assertChannel(channel)
    const pct = patch.estimated_take_rate_pct ?? patch.commission_pct
    const fixed = patch.commission_fixed
    if (pct != null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) {
      throw new BadRequestException('estimated_take_rate_pct fora do intervalo (0-100)')
    }
    if (fixed != null && (!Number.isFinite(fixed) || fixed < 0)) {
      throw new BadRequestException('commission_fixed inválido')
    }
    const row: Record<string, unknown> = {
      organization_id: orgId,
      channel,
      updated_at: new Date().toISOString(),
    }
    // Fase 1 já está 100% no ar — escreve só a coluna nova. A coluna legada
    // commission_pct é removida na migration de limpeza desta fase.
    if (pct != null) row.estimated_take_rate_pct = pct
    if (fixed != null) row.commission_fixed = fixed
    if (patch.notes !== undefined) row.notes = patch.notes
    const { data, error } = await supabaseAdmin
      .from('org_channel_settings')
      .upsert(row, { onConflict: 'organization_id,channel' })
      .select('channel, estimated_take_rate_pct, commission_fixed, notes, updated_at')
      .maybeSingle<ChannelSettingRow>()
    if (error || !data) {
      throw new BadRequestException(`Falha ao salvar config de canal: ${error?.message ?? 'unknown'}`)
    }
    return toSetting(data)
  }

  /** Helper pra outros services: take rate estimado efetivo (%) com fallback.
   *  Usado pra estimar o platform_fee dos pedidos pré-venda (Shopee/TikTok). */
  async getEstimatedTakeRatePct(orgId: string, channel: Channel, fallback = 0): Promise<number> {
    const s = await this.get(orgId, channel)
    if (s == null || !Number.isFinite(Number(s.estimated_take_rate_pct))) return fallback
    return Number(s.estimated_take_rate_pct)
  }

  /** Regras de take por faixa/categoria vigentes na data (default hoje). Lê uma
   *  vez e o caller resolve N itens em memória via `pickRuleTakeRate`. */
  async getFeeRules(orgId: string, channel: Channel, onDate?: string): Promise<ChannelFeeRule[]> {
    this.assertChannel(channel)
    const day = (onDate ?? new Date().toISOString()).slice(0, 10)
    const { data } = await supabaseAdmin
      .from('channel_fee_rules')
      .select('category_id, min_price, max_price, estimated_take_rate_pct, fixed_fee, effective_from, effective_to')
      .eq('organization_id', orgId)
      .eq('channel', channel)
      .lte('effective_from', day)
    const rows = (data ?? []) as Array<ChannelFeeRule & { effective_from: string; effective_to: string | null }>
    return rows
      .filter(r => r.effective_to == null || r.effective_to >= day)
      .map(({ category_id, min_price, max_price, estimated_take_rate_pct, fixed_fee }) => ({
        category_id, min_price, max_price,
        estimated_take_rate_pct: Number(estimated_take_rate_pct),
        fixed_fee: Number(fixed_fee) || 0,
      }))
  }

  /** Take rate efetivo (%) pra UM item: tenta a regra por faixa/categoria; se
   *  nenhuma casa, cai no take achatado de org_channel_settings (e depois no
   *  fallback). Pra callers de item único (ex.: calculadora de campanha). */
  async resolveTakeRatePct(
    orgId: string,
    channel: Channel,
    opts: { price?: number | null; categoryId?: string | null; date?: string; fallback?: number } = {},
  ): Promise<number> {
    const rules = await this.getFeeRules(orgId, channel, opts.date)
    const byRule = pickRuleTakeRate(rules, opts.price, opts.categoryId)
    if (byRule != null) return byRule
    return this.getEstimatedTakeRatePct(orgId, channel, opts.fallback ?? 0)
  }

  // ── CRUD de regras de take por faixa/categoria (gestão pela UI) ────────────

  /** Lista TODAS as regras do canal (com id, pra gestão). Mais específica 1º. */
  async listFeeRules(orgId: string, channel: Channel): Promise<FeeRuleRow[]> {
    this.assertChannel(channel)
    const { data } = await supabaseAdmin
      .from('channel_fee_rules')
      .select('id, channel, category_id, min_price, max_price, estimated_take_rate_pct, fixed_fee, effective_from, effective_to, notes')
      .eq('organization_id', orgId)
      .eq('channel', channel)
      .order('category_id', { ascending: true, nullsFirst: true })
      .order('min_price', { ascending: true, nullsFirst: true })
    return (data ?? []) as FeeRuleRow[]
  }

  /** Cria uma regra de take. estimated_take_rate_pct obrigatório (0-100). */
  async createFeeRule(orgId: string, channel: Channel, input: FeeRuleInput): Promise<FeeRuleRow> {
    this.assertChannel(channel)
    const pct = Number(input.estimated_take_rate_pct)
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new BadRequestException('estimated_take_rate_pct fora do intervalo (0-100)')
    }
    const min = input.min_price == null ? null : Number(input.min_price)
    const max = input.max_price == null ? null : Number(input.max_price)
    if (min != null && max != null && max <= min) {
      throw new BadRequestException('max_price deve ser maior que min_price')
    }
    const row = {
      organization_id: orgId,
      channel,
      category_id: input.category_id?.trim() || null,
      min_price: min,
      max_price: max,
      estimated_take_rate_pct: pct,
      fixed_fee: input.fixed_fee == null ? 0 : Number(input.fixed_fee),
      effective_from: input.effective_from || new Date().toISOString().slice(0, 10),
      notes: input.notes ?? null,
    }
    const { data, error } = await supabaseAdmin
      .from('channel_fee_rules')
      .insert(row)
      .select('id, channel, category_id, min_price, max_price, estimated_take_rate_pct, fixed_fee, effective_from, effective_to, notes')
      .maybeSingle<FeeRuleRow>()
    if (error || !data) throw new BadRequestException(`Falha ao criar regra: ${error?.message ?? 'unknown'}`)
    return data
  }

  /** Atualiza uma regra (escopo org). */
  async updateFeeRule(orgId: string, id: string, patch: Partial<FeeRuleInput>): Promise<FeeRuleRow> {
    const upd: Record<string, unknown> = {}
    if (patch.estimated_take_rate_pct != null) {
      const pct = Number(patch.estimated_take_rate_pct)
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new BadRequestException('estimated_take_rate_pct fora do intervalo (0-100)')
      upd.estimated_take_rate_pct = pct
    }
    if (patch.category_id !== undefined) upd.category_id = patch.category_id?.trim() || null
    if (patch.min_price !== undefined) upd.min_price = patch.min_price == null ? null : Number(patch.min_price)
    if (patch.max_price !== undefined) upd.max_price = patch.max_price == null ? null : Number(patch.max_price)
    if (patch.fixed_fee !== undefined) upd.fixed_fee = patch.fixed_fee == null ? 0 : Number(patch.fixed_fee)
    if (patch.effective_from !== undefined) upd.effective_from = patch.effective_from
    if (patch.notes !== undefined) upd.notes = patch.notes
    const { data, error } = await supabaseAdmin
      .from('channel_fee_rules')
      .update(upd)
      .eq('id', id)
      .eq('organization_id', orgId)
      .select('id, channel, category_id, min_price, max_price, estimated_take_rate_pct, fixed_fee, effective_from, effective_to, notes')
      .maybeSingle<FeeRuleRow>()
    if (error || !data) throw new BadRequestException(`Falha ao atualizar regra: ${error?.message ?? 'não encontrada'}`)
    return data
  }

  /** Remove uma regra (escopo org). */
  async deleteFeeRule(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('channel_fee_rules')
      .delete()
      .eq('id', id)
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Falha ao remover regra: ${error.message}`)
    return { ok: true }
  }

  private assertChannel(channel: string): void {
    if (!VALID_CHANNELS.has(channel as Channel)) {
      throw new BadRequestException(`channel inválido: ${channel}`)
    }
  }
}

/** Regra completa (com id) pra gestão na UI. */
export interface FeeRuleRow {
  id: string
  channel: Channel
  category_id: string | null
  min_price: number | null
  max_price: number | null
  estimated_take_rate_pct: number
  fixed_fee: number
  effective_from: string
  effective_to: string | null
  notes: string | null
}
export interface FeeRuleInput {
  category_id?: string | null
  min_price?: number | null
  max_price?: number | null
  estimated_take_rate_pct: number
  fixed_fee?: number | null
  effective_from?: string
  notes?: string | null
}
