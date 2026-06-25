import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { ActiveBridgeClient } from '../active-bridge/active-bridge.client'
import { MakerworldRadarService } from './makerworld-radar.service'

/**
 * Product OS — Fase 7: alerta automático de insumo.
 * Cron diário (12:00) varre os insumos abaixo do limite por org e manda um
 * digest pelo Active (que entrega WhatsApp ao lojista). Naturalmente
 * throttled (1×/dia). Best-effort, nunca lança.
 */
@Injectable()
export class ProductOsCronService {
  private readonly logger = new Logger(ProductOsCronService.name)

  constructor(
    private readonly bridge: ActiveBridgeClient,
    private readonly radar: MakerworldRadarService,
  ) {}

  /**
   * Radar de campeões (Peça 3): re-fotografa diariamente (08:00) os modelos
   * observados de cada org, gravando um snapshot por item. É o que alimenta a
   * velocidade semanal. Best-effort, gentil com a API não-oficial (1×/dia).
   */
  @Cron('0 8 * * *', { name: 'product-os-radar-refresh' })
  async refreshRadar(): Promise<{ orgs: number; refreshed: number; failed: number }> {
    const { data, error } = await supabaseAdmin.from('mw_watch_item')
      .select('organization_id').eq('is_active', true)
    if (error) { this.logger.warn(`[product-os.cron] radar: ${error.message}`); return { orgs: 0, refreshed: 0, failed: 0 } }
    const orgs = [...new Set((data ?? []).map(r => (r as { organization_id: string }).organization_id))]
    let refreshed = 0, failed = 0
    for (const orgId of orgs) {
      try { const r = await this.radar.refresh(orgId); refreshed += r.refreshed; failed += r.failed }
      catch (e) { this.logger.warn(`[product-os.cron] radar ${orgId.slice(0, 8)}: ${(e as Error).message}`) }
    }
    if (refreshed || failed) this.logger.log(`[product-os.cron] radar: ${orgs.length} org(s), ${refreshed} ok, ${failed} falhas`)
    return { orgs: orgs.length, refreshed, failed }
  }

  /**
   * Alerta de novidades de criador: cron diário (09:00) varre os criadores
   * seguidos de cada org, detecta lançamentos novos e manda um digest por
   * WhatsApp. Best-effort, 1ª passada de cada criador só semeia (não avisa).
   */
  @Cron('0 9 * * *', { name: 'product-os-creator-novelties' })
  async checkCreatorNovelties(): Promise<{ orgs_alerted: number }> {
    if (!this.bridge.isConfigured()) { this.logger.log('[product-os.cron] bridge off — sem alerta de criador'); return { orgs_alerted: 0 } }
    const { data, error } = await supabaseAdmin.from('mw_tracked_creator').select('organization_id').eq('is_active', true)
    if (error) { this.logger.warn(`[product-os.cron] criadores: ${error.message}`); return { orgs_alerted: 0 } }
    const orgs = [...new Set((data ?? []).map(r => (r as { organization_id: string }).organization_id))]
    let alerted = 0
    for (const orgId of orgs) {
      try {
        const news = await this.radar.scanCreatorNovelties(orgId)
        if (!news.length) continue
        const blocks = news.map(n => `*${n.creator}* (${n.platform}) lançou ${n.items.length}:\n${n.items.map(i => `• ${i.title}`).join('\n')}`)
        const msg = `🔔 *Novidades de criadores que você segue* (Product OS)\n\n${blocks.join('\n\n')}\n\nVeja no Radar › Criadores.`
        const r = await this.bridge.notifyLojista({ organization_id: orgId, message: msg, severity: 'low', deeplink: 'producao/product-os' })
        if (!r.skipped) alerted++
      } catch (e) { this.logger.warn(`[product-os.cron] criadores ${orgId.slice(0, 8)}: ${(e as Error).message}`) }
    }
    if (alerted) this.logger.log(`[product-os.cron] novidades de criador → ${alerted} org(s)`)
    return { orgs_alerted: alerted }
  }

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
