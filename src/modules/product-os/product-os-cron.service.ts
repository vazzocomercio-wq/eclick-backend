import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { ActiveBridgeClient } from '../active-bridge/active-bridge.client'

/**
 * Product OS — Fase 7: alerta automático de insumo.
 * Cron diário (12:00) varre os insumos abaixo do limite por org e manda um
 * digest pelo Active (que entrega WhatsApp ao lojista). Naturalmente
 * throttled (1×/dia). Best-effort, nunca lança.
 */
@Injectable()
export class ProductOsCronService {
  private readonly logger = new Logger(ProductOsCronService.name)

  constructor(private readonly bridge: ActiveBridgeClient) {}

  @Cron('0 12 * * *', { name: 'product-os-input-alerts' })
  async checkInputAlerts(): Promise<{ orgs_alerted: number }> {
    if (!this.bridge.isConfigured()) { this.logger.log('[product-os.cron] bridge off — sem alerta de insumo'); return { orgs_alerted: 0 } }
    const { data, error } = await supabaseAdmin.from('production_input')
      .select('organization_id, name, quantity, reserved_quantity, reorder_threshold, unit')
      .eq('is_active', true).gt('reorder_threshold', 0)
    if (error) { this.logger.warn(`[product-os.cron] ${error.message}`); return { orgs_alerted: 0 } }

    const byOrg = new Map<string, string[]>()
    for (const i of data ?? []) {
      const row = i as { organization_id: string; name: string; quantity: number; reserved_quantity: number; reorder_threshold: number; unit: string }
      const avail = Number(row.quantity) - Number(row.reserved_quantity)
      if (avail <= Number(row.reorder_threshold)) {
        const list = byOrg.get(row.organization_id) ?? []
        list.push(`• ${row.name}: ${Math.round(avail * 100) / 100} ${row.unit} disponível`)
        byOrg.set(row.organization_id, list)
      }
    }

    let alerted = 0
    for (const [orgId, items] of byOrg) {
      const msg = `⚠️ *Insumos para repor* (Product OS)\n\n${items.join('\n')}\n\nAbasteça antes que falte na produção.`
      try {
        const r = await this.bridge.notifyLojista({ organization_id: orgId, message: msg, severity: 'medium', deeplink: 'catalogo/product-os' })
        if (!r.skipped) alerted++
      } catch (e) { this.logger.warn(`[product-os.cron] notify ${orgId.slice(0, 8)}: ${(e as Error).message}`) }
    }
    if (alerted) this.logger.log(`[product-os.cron] alerta de insumo enviado p/ ${alerted} org(s)`)
    return { orgs_alerted: alerted }
  }
}
