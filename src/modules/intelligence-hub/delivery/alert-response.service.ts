import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import type { DeliveryResponse } from '../analyzers/analyzers.types'

interface ManagerRow {
  id:    string
  name:  string
}

interface DeliveryRow {
  id:        string
  signal_id: string
  manager_id: string
}

const RESPONSE_LOOKBACK_HOURS = 6  // só matcheia respostas de alertas das últimas 6h

/**
 * Detecta se uma mensagem inbound do WhatsApp é resposta de gestor a um
 * alerta pendente. Se sim, atualiza alert_deliveries.response_* e
 * alert_signals.status conforme o caso.
 *
 * Mapping de body → response_type:
 *   "1" / "sim" / "aprovar"     → approve  → signal.status = 'acted'
 *   "2" / "detalhes" / "info"   → details
 *   "3" / "não" / "ignorar"     → ignore   → signal.status = 'ignored'
 *   qualquer outra coisa        → custom   (não muda signal status)
 *
 * Best-effort: erros são logados mas não interrompem o fluxo de inbound
 * (que pode ter outros consumidores no futuro: CRM, IA, etc).
 */
@Injectable()
export class AlertResponseService {
  private readonly logger = new Logger(AlertResponseService.name)

  async handleInbound(
    orgId:     string,
    phone:     string | null,
    body:      string,
  ): Promise<{ matched: boolean; delivery_id?: string; response_type?: DeliveryResponse }> {
    if (!phone || !body?.trim()) return { matched: false }

    const sanitizedPhone = phone.replace(/\D/g, '')
    if (sanitizedPhone.length < 10) return { matched: false }

    // 1. Achar manager ativo+verificado por phone
    const { data: managers, error: mErr } = await supabaseAdmin
      .from('alert_managers')
      .select('id, name')
      .eq('organization_id', orgId)
      .eq('phone', sanitizedPhone)
      .eq('status', 'active')
      .eq('verified', true)
      .limit(1)
    if (mErr) {
      this.logger.error(`[response] org=${orgId} manager query: ${mErr.message}`)
      return { matched: false }
    }
    const manager = (managers ?? [])[0] as ManagerRow | undefined
    if (!manager) return { matched: false }

    // 2. Última delivery sent desse manager sem resposta, dentro do lookback
    const lookbackSince = new Date(Date.now() - RESPONSE_LOOKBACK_HOURS * 3_600_000).toISOString()
    const { data: deliveries, error: dErr } = await supabaseAdmin
      .from('alert_deliveries')
      .select('id, signal_id, manager_id')
      .eq('manager_id', manager.id)
      .eq('status', 'sent')
      .is('response_at', null)
      .gte('sent_at', lookbackSince)
      .order('sent_at', { ascending: false })
      .limit(1)
    if (dErr) {
      this.logger.error(`[response] manager=${manager.id} deliveries query: ${dErr.message}`)
      return { matched: false }
    }
    const delivery = (deliveries ?? [])[0] as DeliveryRow | undefined
    if (!delivery) return { matched: false }

    // 3. Mapear body → response_type
    const responseType = this.mapResponseType(body.trim())

    // 4. Atualizar delivery
    const { error: upErr } = await supabaseAdmin
      .from('alert_deliveries')
      .update({
        response_type: responseType,
        response_text: body.slice(0, 500),
        response_at:   new Date().toISOString(),
      })
      .eq('id', delivery.id)
    if (upErr) {
      this.logger.error(`[response] update delivery=${delivery.id} falhou: ${upErr.message}`)
      return { matched: false }
    }

    // 5. Atualizar signal status quando aplicável
    if (responseType === 'approve' || responseType === 'ignore') {
      const newStatus = responseType === 'approve' ? 'acted' : 'ignored'
      const { error: sErr } = await supabaseAdmin
        .from('alert_signals')
        .update({ status: newStatus })
        .eq('id', delivery.signal_id)
      if (sErr) this.logger.error(`[response] update signal=${delivery.signal_id} falhou: ${sErr.message}`)
    }

    this.logger.log(
      `[response] manager=${manager.id} delivery=${delivery.id} type=${responseType} body="${body.slice(0, 30)}"`,
    )
    return { matched: true, delivery_id: delivery.id, response_type: responseType }
  }

  private mapResponseType(body: string): DeliveryResponse {
    const norm = body.toLowerCase().trim()
    // matches exatos primeiro
    if (/^[1١]$/.test(norm) || /^(sim|aprovar|aprov[ao]|ok|yes|confirmar)\.?$/.test(norm)) {
      return 'approve'
    }
    if (/^[2٢]$/.test(norm) || /^(detalhes|detalhe|ver|info|informa[çc][aã]o)\.?$/.test(norm)) {
      return 'details'
    }
    if (/^[3٣]$/.test(norm) || /^(n[aã]o|ignorar|ignore|cancelar|skip|nope|no)\.?$/.test(norm)) {
      return 'ignore'
    }
    return 'custom'
  }
}
