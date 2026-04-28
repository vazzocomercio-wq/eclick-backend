import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { NotificationSettings } from './types'

@Injectable()
export class NotificationSettingsService {
  private readonly logger = new Logger(NotificationSettingsService.name)

  async getOrCreate(orgId: string): Promise<NotificationSettings> {
    const { data: existing } = await supabaseAdmin
      .from('pricing_notification_settings').select('*')
      .eq('organization_id', orgId).maybeSingle()
    if (existing) return existing as NotificationSettings

    const { data, error } = await supabaseAdmin
      .from('pricing_notification_settings').insert({ organization_id: orgId }).select().single()
    if (error) throw new BadRequestException(error.message)
    return data as NotificationSettings
  }

  async update(orgId: string, patch: Partial<NotificationSettings>): Promise<NotificationSettings> {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const k of [
      'whatsapp_enabled','whatsapp_phone','notify_severities','notify_signal_types',
      'quiet_hours_start','quiet_hours_end','notify_weekends',
      'group_notifications','group_window_minutes','max_per_hour','max_per_day',
    ] as const) {
      if (patch[k] !== undefined) update[k] = patch[k]
    }

    // Garante que existe
    await this.getOrCreate(orgId)

    const { data, error } = await supabaseAdmin
      .from('pricing_notification_settings').update(update)
      .eq('organization_id', orgId).select().single()
    if (error) throw new BadRequestException(error.message)
    return data as NotificationSettings
  }
}
