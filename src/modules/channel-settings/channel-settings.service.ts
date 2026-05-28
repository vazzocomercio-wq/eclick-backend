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
  commission_pct: number
  commission_fixed: number
  notes: string | null
  updated_at: string | null
}

/** Custos por canal (org × canal) — comissão %, taxa fixa, etc.
 *  Fonte da estimativa do platform_fee dos pedidos quando a API do canal NÃO
 *  devolve a comissão real no order (caso TikTok — só vem em Statements).
 *  Cada canal tem seus custos distintos; este service trata de forma uniforme. */
@Injectable()
export class ChannelSettingsService {
  /** Lê a config de UM canal pra org (ou null se nunca foi configurada). */
  async get(orgId: string, channel: Channel): Promise<ChannelSetting | null> {
    this.assertChannel(channel)
    const { data } = await supabaseAdmin
      .from('org_channel_settings')
      .select('channel, commission_pct, commission_fixed, notes, updated_at')
      .eq('organization_id', orgId)
      .eq('channel', channel)
      .maybeSingle<ChannelSetting>()
    return data ?? null
  }

  /** Lê TODOS os canais configurados pra org (lista pra UI de configurações). */
  async listForOrg(orgId: string): Promise<ChannelSetting[]> {
    const { data } = await supabaseAdmin
      .from('org_channel_settings')
      .select('channel, commission_pct, commission_fixed, notes, updated_at')
      .eq('organization_id', orgId)
      .order('channel', { ascending: true })
    return (data ?? []) as ChannelSetting[]
  }

  /** Upsert da config de UM canal pra org. */
  async upsert(
    orgId: string,
    channel: Channel,
    patch: { commission_pct?: number; commission_fixed?: number; notes?: string | null },
  ): Promise<ChannelSetting> {
    this.assertChannel(channel)
    const pct = patch.commission_pct
    const fixed = patch.commission_fixed
    if (pct != null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) {
      throw new BadRequestException('commission_pct fora do intervalo (0-100)')
    }
    if (fixed != null && (!Number.isFinite(fixed) || fixed < 0)) {
      throw new BadRequestException('commission_fixed inválido')
    }
    const row: Record<string, unknown> = {
      organization_id: orgId,
      channel,
      updated_at: new Date().toISOString(),
    }
    if (pct != null) row.commission_pct = pct
    if (fixed != null) row.commission_fixed = fixed
    if (patch.notes !== undefined) row.notes = patch.notes
    const { data, error } = await supabaseAdmin
      .from('org_channel_settings')
      .upsert(row, { onConflict: 'organization_id,channel' })
      .select('channel, commission_pct, commission_fixed, notes, updated_at')
      .maybeSingle<ChannelSetting>()
    if (error || !data) {
      throw new BadRequestException(`Falha ao salvar config de canal: ${error?.message ?? 'unknown'}`)
    }
    return data
  }

  /** Helper pra outros services: comissão efetiva (%) com fallback. Usado pelo
   *  ingestion do TikTok pra estimar platform_fee quando a API não devolve. */
  async getCommissionPct(orgId: string, channel: Channel, fallback = 0): Promise<number> {
    const s = await this.get(orgId, channel)
    if (s == null || !Number.isFinite(Number(s.commission_pct))) return fallback
    return Number(s.commission_pct)
  }

  private assertChannel(channel: string): void {
    if (!VALID_CHANNELS.has(channel as Channel)) {
      throw new BadRequestException(`channel inválido: ${channel}`)
    }
  }
}
