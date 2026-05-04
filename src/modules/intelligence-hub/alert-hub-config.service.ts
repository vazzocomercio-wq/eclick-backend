import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import type { UpdateHubConfigDto } from './dto/update-hub-config.dto'

/**
 * Config global do Intelligence Hub por organização.
 *
 * Singleton por org (UNIQUE em organization_id). Defaults criados via upsert
 * quando GET for chamado pela primeira vez — evita estado divergente entre
 * onboarding e uso normal.
 */
@Injectable()
export class AlertHubConfigService {
  private readonly logger = new Logger(AlertHubConfigService.name)

  async get(orgId: string) {
    const { data, error } = await supabaseAdmin
      .from('alert_hub_config')
      .select('*')
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) throw new BadRequestException(error.message)

    if (!data) {
      const created = await this.ensureExists(orgId)
      return created
    }
    return data
  }

  async ensureExists(orgId: string) {
    const { data, error } = await supabaseAdmin
      .from('alert_hub_config')
      .upsert(
        { organization_id: orgId },
        { onConflict: 'organization_id', ignoreDuplicates: false },
      )
      .select()
      .single()
    if (error) throw new BadRequestException(error.message)
    return data
  }

  async update(orgId: string, dto: UpdateHubConfigDto) {
    await this.ensureExists(orgId)

    const payload: Record<string, unknown> = {}
    if (dto.enabled !== undefined)                         payload.enabled                        = dto.enabled
    if (dto.analyzers_config !== undefined)                payload.analyzers_config               = dto.analyzers_config
    if (dto.digest_config !== undefined)                   payload.digest_config                  = dto.digest_config
    if (dto.quiet_hours !== undefined)                     payload.quiet_hours                    = dto.quiet_hours
    if (dto.cross_intel_enabled !== undefined)             payload.cross_intel_enabled            = dto.cross_intel_enabled
    if (dto.max_alerts_per_manager_per_day !== undefined)  payload.max_alerts_per_manager_per_day = dto.max_alerts_per_manager_per_day
    if (dto.min_interval_minutes !== undefined)            payload.min_interval_minutes           = dto.min_interval_minutes
    if (dto.learning_enabled !== undefined)                payload.learning_enabled               = dto.learning_enabled
    if (dto.learning_decay_days !== undefined)             payload.learning_decay_days            = dto.learning_decay_days
    payload.updated_at = new Date().toISOString()

    const { data, error } = await supabaseAdmin
      .from('alert_hub_config')
      .update(payload)
      .eq('organization_id', orgId)
      .select()
      .single()
    if (error) throw new BadRequestException(error.message)
    return data
  }

  async setEnabled(orgId: string, enabled: boolean) {
    await this.ensureExists(orgId)
    const { data, error } = await supabaseAdmin
      .from('alert_hub_config')
      .update({ enabled, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .select()
      .single()
    if (error) throw new BadRequestException(error.message)
    this.logger.log(`[hub] org=${orgId} enabled=${enabled}`)
    return data
  }
}
