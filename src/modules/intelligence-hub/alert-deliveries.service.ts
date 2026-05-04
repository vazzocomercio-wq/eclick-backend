import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import {
  type AlertDelivery, type DeliveryDraft, type DeliveryStatus,
} from './analyzers/analyzers.types'

/**
 * Persistência e queries de alert_deliveries.
 *
 * Não envia mensagens — só registra. O envio real WhatsApp fica com
 * WhatsAppDeliveryService (sprint IH-3).
 */
@Injectable()
export class AlertDeliveriesService {
  private readonly logger = new Logger(AlertDeliveriesService.name)

  async insertMany(drafts: DeliveryDraft[]): Promise<AlertDelivery[]> {
    if (drafts.length === 0) return []

    const rows = drafts.map(d => ({
      organization_id: d.organization_id,
      signal_id:       d.signal_id,
      manager_id:      d.manager_id,
      channel:         d.channel       ?? 'whatsapp',
      delivery_type:   d.delivery_type ?? 'immediate',
      status:          'pending',
    }))

    const { data, error } = await supabaseAdmin
      .from('alert_deliveries')
      .insert(rows)
      .select()
    if (error) throw new BadRequestException(error.message)

    this.logger.log(`[insertMany] count=${data?.length ?? 0}`)
    return (data ?? []) as AlertDelivery[]
  }

  async list(orgId: string, filters: {
    manager_id?: string
    signal_id?:  string
    status?:     DeliveryStatus
    limit?:      number
  } = {}): Promise<AlertDelivery[]> {
    let q = supabaseAdmin
      .from('alert_deliveries')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(filters.limit ?? 100)

    if (filters.manager_id) q = q.eq('manager_id', filters.manager_id)
    if (filters.signal_id)  q = q.eq('signal_id', filters.signal_id)
    if (filters.status)     q = q.eq('status', filters.status)

    const { data, error } = await q
    if (error) throw new BadRequestException(error.message)
    return (data ?? []) as AlertDelivery[]
  }

  /**
   * Conta deliveries criadas hoje pra um gestor — anti-spam check.
   */
  async countTodayByManager(managerId: string): Promise<number> {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const { count, error } = await supabaseAdmin
      .from('alert_deliveries')
      .select('id', { count: 'exact', head: true })
      .eq('manager_id', managerId)
      .gte('created_at', startOfDay.toISOString())
    if (error) throw new BadRequestException(error.message)
    return count ?? 0
  }

  /**
   * Última delivery criada pro gestor — usado pra checar min_interval.
   */
  async lastByManager(managerId: string): Promise<AlertDelivery | null> {
    const { data, error } = await supabaseAdmin
      .from('alert_deliveries')
      .select('*')
      .eq('manager_id', managerId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new BadRequestException(error.message)
    return (data as AlertDelivery | null) ?? null
  }
}
