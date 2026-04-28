import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/** Defaults aplicados quando a row não existe. CPF/phone/email mascarados
 * por default (LGPD-friendly). Export NÃO mascara — CSV é offline e
 * geralmente o usuário precisa do dado completo pra trabalhar. */
export const PREF_DEFAULTS: Record<string, string> = {
  mask_cpf:    'true',
  mask_phone:  'true',
  mask_email:  'true',
  mask_export: 'false',
}

@Injectable()
export class UserPreferencesService {
  private readonly logger = new Logger(UserPreferencesService.name)

  /** Retorna todas as prefs do usuário com defaults aplicados. */
  async getAll(userId: string): Promise<Record<string, string>> {
    const { data } = await supabaseAdmin
      .from('user_preferences')
      .select('key, value')
      .eq('user_id', userId)

    const out: Record<string, string> = { ...PREF_DEFAULTS }
    for (const row of data ?? []) {
      if (row.key) out[row.key as string] = String(row.value ?? '')
    }
    return out
  }

  /** Upsert de uma única chave. Quando o valor é IGUAL ao default,
   * deleta a row pra manter a tabela enxuta. */
  async upsert(userId: string, key: string, value: string): Promise<{ ok: true }> {
    const isDefault = PREF_DEFAULTS[key] === value
    if (isDefault) {
      await supabaseAdmin.from('user_preferences')
        .delete()
        .eq('user_id', userId)
        .eq('key', key)
      return { ok: true }
    }
    const { error } = await supabaseAdmin.from('user_preferences')
      .upsert(
        { user_id: userId, key, value, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,key' },
      )
    if (error) this.logger.error(`[user-prefs.upsert] ${error.message}`)
    return { ok: true }
  }

  /** Append-only LGPD audit. Disparado pelo <MaskedField> toda vez que
   * o usuário clica no eye pra revelar um CPF/phone/email. Nunca lança
   * — falha silenciosa pra não quebrar a UI. */
  async logReveal(input: {
    userId:      string
    field:       'cpf' | 'cnpj' | 'phone' | 'email'
    customerId?: string | null
    ip?:         string | null
    userAgent?:  string | null
  }): Promise<{ ok: true }> {
    try {
      await supabaseAdmin.from('pii_reveal_log').insert({
        user_id:     input.userId,
        customer_id: input.customerId ?? null,
        field:       input.field,
        ip:          input.ip ?? null,
        user_agent:  input.userAgent ?? null,
      })
    } catch (e: unknown) {
      this.logger.warn(`[pii-reveal] ${(e as Error)?.message}`)
    }
    return { ok: true }
  }

  /** Últimos N reveals do usuário — usado pelo card "Auditoria" em
   * /configuracoes/preferencias. */
  async listRecentReveals(userId: string, limit = 50): Promise<Array<{
    field: string; customer_id: string | null; revealed_at: string
  }>> {
    const { data } = await supabaseAdmin
      .from('pii_reveal_log')
      .select('field, customer_id, revealed_at')
      .eq('user_id', userId)
      .order('revealed_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 200))
    return (data ?? []) as Array<{ field: string; customer_id: string | null; revealed_at: string }>
  }
}
