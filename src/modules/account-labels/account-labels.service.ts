import { Injectable, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/** Mapa de nomes customizados por plataforma → { account_key: display_name }. */
export type AccountLabelMap = Record<string, Record<string, string>>

export interface AccountLabelRow {
  platform:     string
  account_key:  string
  display_name: string
}

/**
 * Nome de exibição customizado por conta/loja (tabela `account_labels`).
 * Fonte única da identidade visível das contas em todo o sistema. Usado pra
 * sobrescrever o nickname cru do marketplace (ex: ML "V20251215105533" → "Casa Luz").
 * account_key: seller_id (ML) | shop_id (Shopee) | account_id (TikTok), como texto.
 */
@Injectable()
export class AccountLabelsService {
  /** Mapa { platform: { account_key: display_name } } pra resolução rápida. */
  async getMap(orgId: string): Promise<AccountLabelMap> {
    const { data } = await supabaseAdmin
      .from('account_labels')
      .select('platform, account_key, display_name')
      .eq('organization_id', orgId)
    const map: AccountLabelMap = {}
    for (const r of (data ?? []) as AccountLabelRow[]) {
      (map[r.platform] ??= {})[r.account_key] = r.display_name
    }
    return map
  }

  /** Lista os labels já definidos (pra UI saber o que foi customizado). */
  async list(orgId: string): Promise<AccountLabelRow[]> {
    const { data } = await supabaseAdmin
      .from('account_labels')
      .select('platform, account_key, display_name')
      .eq('organization_id', orgId)
    return (data ?? []) as AccountLabelRow[]
  }

  /** Cria/atualiza o nome de uma conta. */
  async upsert(orgId: string, platform: string, accountKey: string | number, displayName: string) {
    const name = (displayName ?? '').trim()
    if (!platform || accountKey == null || accountKey === '') {
      throw new BadRequestException('platform e account_key são obrigatórios')
    }
    if (!name) throw new BadRequestException('display_name é obrigatório')
    if (name.length > 80) throw new BadRequestException('display_name muito longo (máx 80)')
    const { data, error } = await supabaseAdmin
      .from('account_labels')
      .upsert(
        {
          organization_id: orgId,
          platform,
          account_key:     String(accountKey),
          display_name:    name,
          updated_at:      new Date().toISOString(),
        },
        { onConflict: 'organization_id,platform,account_key' },
      )
      .select('platform, account_key, display_name')
      .maybeSingle()
    if (error) throw new Error(error.message)
    return data
  }

  /** Remove o nome custom (volta a usar o nickname cru do marketplace). */
  async remove(orgId: string, platform: string, accountKey: string) {
    const { error } = await supabaseAdmin
      .from('account_labels')
      .delete()
      .eq('organization_id', orgId)
      .eq('platform', platform)
      .eq('account_key', String(accountKey))
    if (error) throw new Error(error.message)
    return { ok: true }
  }
}
