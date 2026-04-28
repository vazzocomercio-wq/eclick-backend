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
}
