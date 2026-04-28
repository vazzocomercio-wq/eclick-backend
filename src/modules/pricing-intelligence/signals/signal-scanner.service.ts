import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { ProductSnapshotService } from './product-snapshot.service'
import { SignalDetectorService } from './signal-detector.service'
import { SignalNotifierService } from './signal-notifier.service'
import { PricingSignal } from './types'

/** Cron @ a cada 2h (offset 7min pra evitar :00 lotado): varre produtos
 * ativos de cada org, gera snapshots, detecta sinais, persiste com dedup,
 * expira antigos e dispara notifier. */
@Injectable()
export class SignalScannerService {
  private readonly logger = new Logger(SignalScannerService.name)

  constructor(
    private readonly snap:     ProductSnapshotService,
    private readonly detector: SignalDetectorService,
    private readonly notifier: SignalNotifierService,
  ) {}

  @Cron('7 */2 * * *', { name: 'pricingSignalScanTick' })
  async tick(): Promise<void> {
    const t0 = Date.now()
    let totalProducts = 0, totalNew = 0, totalExpired = 0

    // 1. Expira sinais antigos primeiro (housekeeping)
    totalExpired = await this.expireOldSignals()

    // 2. Lista orgs ativas (têm produtos)
    const { data: orgs } = await supabaseAdmin
      .from('products').select('organization_id').limit(10_000)
    const orgIds = [...new Set((orgs ?? []).map(r => r.organization_id as string))].filter(Boolean)

    for (const orgId of orgIds) {
      try {
        const r = await this.scanOrg(orgId)
        totalProducts += r.products
        totalNew      += r.newSignals
      } catch (e: unknown) {
        this.logger.warn(`[pricing.signals] org=${orgId} scan falhou: ${(e as Error)?.message}`)
      }
    }

    // 3. Notifica
    let notif = { sent: 0, failed: 0 }
    try {
      const r = await this.notifier.notifyAllOrgs()
      notif = { sent: r.sent, failed: r.failed }
    } catch (e: unknown) {
      this.logger.warn(`[pricing.signals] notify falhou: ${(e as Error)?.message}`)
    }

    const dur = Math.round((Date.now() - t0) / 1000)
    this.logger.log(`[pricing.signals] ${totalProducts} produtos, ${totalNew} sinais novos, ${notif.sent} notificados, ${totalExpired} expirados — ${dur}s`)
  }

  /** Scan manual via endpoint pra 1 produto. */
  async scanProduct(orgId: string, productId: string): Promise<{ created: number; signals: PricingSignal[] }> {
    const snap = await this.snap.getSnapshot(orgId, productId)
    if (!snap) return { created: 0, signals: [] }
    const sigs = this.detector.detectSignals(orgId, snap)
    const created = await this.persistSignals(orgId, sigs)
    return { created, signals: sigs }
  }

  /** Scan manual via endpoint pra org inteira. */
  async scanOrg(orgId: string): Promise<{ products: number; newSignals: number }> {
    const { data: products } = await supabaseAdmin
      .from('products').select('id')
      .eq('organization_id', orgId)
      .limit(2_000)
    const ids = (products ?? []).map(p => p.id as string)

    let newSignals = 0
    for (const pid of ids) {
      try {
        const r = await this.scanProduct(orgId, pid)
        newSignals += r.created
      } catch (e: unknown) {
        this.logger.warn(`[pricing.signals] org=${orgId} product=${pid} scan falhou: ${(e as Error)?.message}`)
      }
    }
    return { products: ids.length, newSignals }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async expireOldSignals(): Promise<number> {
    const { data, error } = await supabaseAdmin
      .from('pricing_signals')
      .update({ status: 'expired', updated_at: new Date().toISOString() })
      .eq('status', 'active')
      .lt('expires_at', new Date().toISOString())
      .select('id')
    if (error) {
      this.logger.warn(`[pricing.signals] expire falhou: ${error.message}`)
      return 0
    }
    return data?.length ?? 0
  }

  /** Persiste novos signals com dedup: não cria se já existe um active
   * pro mesmo (product_id, signal_type, trigger_id) na mesma org. */
  private async persistSignals(orgId: string, signals: PricingSignal[]): Promise<number> {
    if (signals.length === 0) return 0

    // Lista keys existentes ativos pra dedup
    const productIds = [...new Set(signals.map(s => s.product_id).filter(Boolean) as string[])]
    if (productIds.length === 0) return 0

    const { data: existing } = await supabaseAdmin
      .from('pricing_signals').select('product_id, signal_type, trigger_id')
      .eq('organization_id', orgId).eq('status', 'active')
      .in('product_id', productIds)
    const existingKeys = new Set(
      (existing ?? []).map(r => `${r.product_id}|${r.signal_type}|${r.trigger_id}`),
    )

    const toInsert = signals.filter(s => {
      if (!s.product_id) return false
      const key = `${s.product_id}|${s.signal_type}|${s.trigger_id}`
      return !existingKeys.has(key)
    })

    if (toInsert.length === 0) return 0

    const { error } = await supabaseAdmin.from('pricing_signals').insert(toInsert)
    if (error) {
      this.logger.warn(`[pricing.signals] insert falhou: ${error.message}`)
      return 0
    }
    return toInsert.length
  }
}
