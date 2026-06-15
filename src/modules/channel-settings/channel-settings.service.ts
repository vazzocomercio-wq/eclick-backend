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
    // dual-write: escreve a coluna nova E a legada enquanto ambas coexistem
    // (back-compat com o backend antigo durante a janela de deploy).
    if (pct != null) { row.estimated_take_rate_pct = pct; row.commission_pct = pct }
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

  private assertChannel(channel: string): void {
    if (!VALID_CHANNELS.has(channel as Channel)) {
      throw new BadRequestException(`channel inválido: ${channel}`)
    }
  }
}
