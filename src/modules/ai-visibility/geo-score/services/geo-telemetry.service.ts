import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../../common/supabase'
import { isValidEventName } from '../../../product-telemetry/catalog/events-catalog'

/**
 * Emite eventos de telemetria de produto a partir do BACKEND (o ciclo de
 * auditoria do GEO Score não tem sessão de frontend). Insere direto em
 * telemetry_events via service_role — best-effort, NUNCA derruba o fluxo.
 *
 * session_id usa o jobId (uuid) pra agrupar os eventos de uma auditoria;
 * não cria telemetry_sessions (o rollup diário agrega por evento mesmo assim).
 */
@Injectable()
export class GeoTelemetryService {
  private readonly logger = new Logger(GeoTelemetryService.name)

  async emit(input: {
    orgId:      string
    userId:     string
    jobId:      string
    eventName:  string
    properties?: Record<string, unknown>
    durationMs?: number
  }): Promise<void> {
    try {
      if (!isValidEventName(input.eventName)) {
        this.logger.warn(`[geo-telemetry] evento fora do catálogo, ignorado: ${input.eventName}`)
        return
      }
      await supabaseAdmin.from('telemetry_events').insert({
        org_id:      input.orgId,
        user_id:     input.userId,
        session_id:  input.jobId,
        event_name:  input.eventName,
        event_type:  'action',
        module:      'ai_visibility',
        feature:     'geo_score',
        duration_ms: Number.isFinite(input.durationMs) ? Math.round(input.durationMs as number) : null,
        properties:  input.properties ?? {},
      })
    } catch (e) {
      this.logger.warn(`[geo-telemetry] emit falhou (${input.eventName}): ${(e as Error).message}`)
    }
  }
}
