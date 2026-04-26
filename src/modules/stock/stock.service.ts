import { Injectable, Logger, HttpException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'

@Injectable()
export class StockService {
  private readonly logger = new Logger(StockService.name)

  constructor(private readonly mlService: MercadolivreService) {}

  // ── Central calculation ───────────────────────────────────────────────────

  async calculateAvailable(productId: string): Promise<{
    physical: number; virtual: number; reserved: number
    safety: number; available: number; total_platform: number
    stock_id: string | null
    safety_mode: string; safety_percentage: number; safety_quantity: number
  }> {
    const { data: stock } = await supabaseAdmin
      .from('product_stock')
      .select('*')
      .eq('product_id', productId)
      .is('platform', null)
      .maybeSingle()

    if (!stock) {
      return {
        physical: 0, virtual: 0, reserved: 0,
        safety: 0, available: 0, total_platform: 0, stock_id: null,
        safety_mode: 'percentage', safety_percentage: 10, safety_quantity: 0,
      }
    }

    const physical  = Number(stock.quantity || 0)
    const virtual_  = Number(stock.virtual_quantity || 0)
    const reserved  = Number(stock.reserved_quantity || 0)
    const safetyPct = Number(stock.safety_percentage || 10)
    const safetyFix = Number(stock.safety_quantity || 0)
    const mode      = stock.safety_mode ?? 'percentage'
    const safety    = mode === 'percentage'
      ? Math.round(physical * safetyPct / 100)
      : safetyFix

    const available      = Math.max(0, physical + virtual_ - reserved - safety)
    const total_platform = physical + virtual_

    return {
      physical, virtual: virtual_, reserved, safety, available, total_platform,
      stock_id: stock.id,
      safety_mode: mode, safety_percentage: safetyPct, safety_quantity: safetyFix,
    }
  }

  async getFullStock(productId: string) {
    const calc         = await this.calculateAvailable(productId)
    const reservations = await this.getActiveReservations(productId)
    const distributions = await this.getDistributions(productId)
    return { ...calc, reservations, distributions }
  }

  // ── Safety settings ───────────────────────────────────────────────────────

  async updateSafety(stockId: string, updates: {
    safety_mode?: string
    safety_percentage?: number
    safety_quantity?: number
  }) {
    this.logger.log(`[updateSafety] stockId=${stockId} updates=${JSON.stringify(updates)}`)

    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (updates.safety_mode) payload.safety_mode = updates.safety_mode
    if (updates.safety_percentage !== undefined) payload.safety_percentage = Number(updates.safety_percentage)
    if (updates.safety_quantity !== undefined) payload.safety_quantity = Number(updates.safety_quantity)

    const { data, error } = await supabaseAdmin
      .from('product_stock')
      .update(payload)
      .eq('id', stockId)
      .select()
      .single()

    if (error) {
      this.logger.error(`[updateSafety] Supabase error code=${error.code} msg=${error.message} details=${error.details}`)
      throw new HttpException(error.message, 400)
    }

    if (!data) {
      this.logger.warn(`[updateSafety] sem linha retornada para stockId=${stockId}`)
      throw new HttpException(`Stock ${stockId} não encontrado`, 404)
    }

    // Re-sync with channels since available qty changed
    if (data.product_id) {
      this.syncStockToAllChannels(data.product_id).catch(e =>
        this.logger.warn(`[updateSafety] sync error: ${e?.message}`),
      )
    }

    return data
  }

  // ── Reservations ──────────────────────────────────────────────────────────

  async reserveStock(params: {
    productId: string
    quantity: number
    referenceType: string
    referenceId: string
    channel: string
  }) {
    const { data: stock } = await supabaseAdmin
      .from('product_stock')
      .select('id, quantity, reserved_quantity')
      .eq('product_id', params.productId)
      .is('platform', null)
      .maybeSingle()

    if (!stock) {
      this.logger.warn(`[stock.reserve] sem stock para ${params.productId}`)
      return null
    }

    // Idempotency: skip if already reserved for this order
    const { data: existing } = await supabaseAdmin
      .from('stock_reservations')
      .select('id')
      .eq('reference_type', params.referenceType)
      .eq('reference_id', params.referenceId)
      .eq('status', 'active')
      .maybeSingle()

    if (existing) return existing

    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()

    const { data: reservation, error } = await supabaseAdmin
      .from('stock_reservations')
      .insert({
        product_id:    params.productId,
        stock_id:      stock.id,
        quantity:      params.quantity,
        reason:        'order_paid',
        reference_type: params.referenceType,
        reference_id:  params.referenceId,
        channel:       params.channel,
        expires_at:    expiresAt,
        status:        'active',
      })
      .select()
      .single()

    if (error) throw error

    const newReserved = (Number(stock.reserved_quantity) || 0) + params.quantity
    await supabaseAdmin
      .from('product_stock')
      .update({ reserved_quantity: newReserved, updated_at: new Date().toISOString() })
      .eq('id', stock.id)

    this.logger.log(`[stock.reserve] +${params.quantity} | total reserved:${newReserved}`)

    this.syncStockToAllChannels(params.productId).catch(e =>
      this.logger.warn('[stock.reserve] sync error:', e.message),
    )

    return reservation
  }

  async consumeReservation(referenceType: string, referenceId: string) {
    const { data: reservation } = await supabaseAdmin
      .from('stock_reservations')
      .select('*')
      .eq('reference_type', referenceType)
      .eq('reference_id', referenceId)
      .eq('status', 'active')
      .maybeSingle()

    if (!reservation) return

    const { data: stock } = await supabaseAdmin
      .from('product_stock')
      .select('quantity, reserved_quantity')
      .eq('id', reservation.stock_id)
      .single()

    const newQty      = Math.max(0, (Number(stock.quantity) || 0) - reservation.quantity)
    const newReserved = Math.max(0, (Number(stock.reserved_quantity) || 0) - reservation.quantity)

    await supabaseAdmin
      .from('product_stock')
      .update({
        quantity:          newQty,
        reserved_quantity: newReserved,
        last_movement_at:  new Date().toISOString(),
        updated_at:        new Date().toISOString(),
      })
      .eq('id', reservation.stock_id)

    await supabaseAdmin
      .from('stock_reservations')
      .update({ status: 'consumed', consumed_at: new Date().toISOString() })
      .eq('id', reservation.id)

    await supabaseAdmin.from('stock_movements').insert({
      product_id:    reservation.product_id,
      product_stock_id: reservation.stock_id,
      type:          'sale',
      quantity:      reservation.quantity,
      reason:        `Venda confirmada: ${reservation.quantity} un.`,
      reference_type: reservation.reference_type,
      reference_id:  reservation.reference_id,
      balance_after: newQty,
    })

    this.logger.log(`[stock.consume] ${reservation.quantity} un | ref:${referenceId}`)

    this.syncStockToAllChannels(reservation.product_id).catch(e =>
      this.logger.warn('[stock.consume] sync error:', e.message),
    )
  }

  async releaseReservation(referenceType: string, referenceId: string) {
    const { data: reservation } = await supabaseAdmin
      .from('stock_reservations')
      .select('*')
      .eq('reference_type', referenceType)
      .eq('reference_id', referenceId)
      .eq('status', 'active')
      .maybeSingle()

    if (!reservation) return

    const { data: stock } = await supabaseAdmin
      .from('product_stock')
      .select('reserved_quantity')
      .eq('id', reservation.stock_id)
      .single()

    const newReserved = Math.max(0, (Number(stock.reserved_quantity) || 0) - reservation.quantity)

    await supabaseAdmin
      .from('product_stock')
      .update({ reserved_quantity: newReserved, updated_at: new Date().toISOString() })
      .eq('id', reservation.stock_id)

    await supabaseAdmin
      .from('stock_reservations')
      .update({ status: 'released', released_at: new Date().toISOString() })
      .eq('id', reservation.id)

    this.logger.log(`[stock.release] ${reservation.quantity} un liberado | ref:${referenceId}`)

    this.syncStockToAllChannels(reservation.product_id).catch(e =>
      this.logger.warn('[stock.release] sync error:', e.message),
    )
  }

  async releaseExpiredReservations(): Promise<number> {
    const { data: expired } = await supabaseAdmin
      .from('stock_reservations')
      .select('*')
      .eq('status', 'active')
      .lt('expires_at', new Date().toISOString())

    for (const r of expired ?? []) {
      const { data: stock } = await supabaseAdmin
        .from('product_stock')
        .select('reserved_quantity')
        .eq('id', r.stock_id)
        .maybeSingle()

      if (stock) {
        const newReserved = Math.max(0, (Number(stock.reserved_quantity) || 0) - r.quantity)
        await supabaseAdmin
          .from('product_stock')
          .update({ reserved_quantity: newReserved, updated_at: new Date().toISOString() })
          .eq('id', r.stock_id)
      }

      await supabaseAdmin
        .from('stock_reservations')
        .update({ status: 'expired', released_at: new Date().toISOString() })
        .eq('id', r.id)

      this.logger.log(`[stock.expire] reserva liberada | ref:${r.reference_id}`)

      this.syncStockToAllChannels(r.product_id).catch(e =>
        this.logger.warn('[stock.expire] sync error:', e.message),
      )
    }

    return expired?.length ?? 0
  }

  async getActiveReservations(productId: string) {
    const { data } = await supabaseAdmin
      .from('stock_reservations')
      .select('id, quantity, reference_type, reference_id, channel, expires_at, created_at')
      .eq('product_id', productId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
    return data ?? []
  }

  async listReservations(status?: string) {
    let q = supabaseAdmin
      .from('stock_reservations')
      .select('*, product:products(name, sku)')
      .order('created_at', { ascending: false })
      .limit(100)

    if (status) q = q.eq('status', status)

    const { data } = await q
    return data ?? []
  }

  async releaseReservationById(id: string) {
    const { data: reservation } = await supabaseAdmin
      .from('stock_reservations')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (!reservation || reservation.status !== 'active') return { ok: false, message: 'Reserva não encontrada ou inativa' }

    await this.releaseReservation(reservation.reference_type, reservation.reference_id)
    return { ok: true }
  }

  // ── Channel distribution ──────────────────────────────────────────────────

  async calculateChannelQuantities(productId: string): Promise<Array<{
    channel: string
    account_id: string | null
    qty: number
    should_pause: boolean
    distribution_id: string | null
    min_quantity: number
  }>> {
    const { available } = await this.calculateAvailable(productId)

    const { data: distributions } = await supabaseAdmin
      .from('channel_stock_distribution')
      .select('*')
      .eq('product_id', productId)
      .eq('is_active', true)
      .order('priority', { ascending: true })

    if (!distributions?.length) {
      // Fallback: no distribution config, use total_platform for ML (existing behavior)
      const { total_platform } = await this.calculateAvailable(productId)
      return [{ channel: 'mercadolivre', account_id: null, qty: total_platform, should_pause: total_platform <= 0, distribution_id: null, min_quantity: 0 }]
    }

    return distributions.map(d => {
      let qty = d.distribution_mode === 'fixed'
        ? (d.fixed_quantity ?? 0)
        : Math.floor(available * ((d.percentage ?? 100) / 100))

      if (d.max_quantity && qty > d.max_quantity) qty = d.max_quantity

      const min         = d.min_quantity ?? 0
      const should_pause = qty <= min

      return {
        channel:         d.channel,
        account_id:      d.account_id,
        qty:             should_pause ? 0 : qty,
        should_pause,
        distribution_id: d.id,
        min_quantity:    min,
      }
    })
  }

  async getDistributions(productId: string) {
    const { data } = await supabaseAdmin
      .from('channel_stock_distribution')
      .select('*')
      .eq('product_id', productId)
      .order('priority', { ascending: true })
    return data ?? []
  }

  async saveDistribution(data: {
    product_id: string
    channel: string
    account_id?: string | null
    distribution_mode?: string
    percentage?: number
    fixed_quantity?: number | null
    min_quantity?: number
    max_quantity?: number | null
    priority?: number
  }) {
    const { data: result, error } = await supabaseAdmin
      .from('channel_stock_distribution')
      .upsert(
        { ...data, is_active: true, updated_at: new Date().toISOString() },
        { onConflict: 'product_id,channel,account_id' },
      )
      .select()
      .single()

    if (error) throw error
    return result
  }

  async updateDistribution(id: string, updates: Partial<{
    distribution_mode: string
    percentage: number
    fixed_quantity: number | null
    min_quantity: number
    max_quantity: number | null
    priority: number
    is_active: boolean
  }>) {
    const { data, error } = await supabaseAdmin
      .from('channel_stock_distribution')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    return data
  }

  async deleteDistribution(id: string) {
    const { error } = await supabaseAdmin
      .from('channel_stock_distribution')
      .delete()
      .eq('id', id)

    if (error) throw error
    return { ok: true }
  }

  // ── ML Sync ───────────────────────────────────────────────────────────────

  async syncStockToAllChannels(productId: string) {
    const channelQtys = await this.calculateChannelQuantities(productId)
    for (const cq of channelQtys) {
      if (cq.channel === 'mercadolivre') {
        await this.syncToMl(productId, cq.qty, cq.should_pause, cq.distribution_id)
      }
    }
  }

  async syncToMl(
    productId: string,
    qty: number,
    shouldPause: boolean,
    distributionId: string | null = null,
    triggeredBy = 'system_distribution',
  ) {
    const { data: vinculos } = await supabaseAdmin
      .from('product_listings')
      .select('listing_id')
      .eq('product_id', productId)
      .eq('platform', 'mercadolivre')
      .eq('is_active', true)

    for (const v of vinculos ?? []) {
      const startTime = Date.now()
      let status: string = 'pending'
      let errorMsg: string | null = null
      let httpStatus = 0
      let confirmedQty: number | null = null

      try {
        if (shouldPause) {
          // Set to 0 so ML auto-pauses when stock depletes
          await this.mlService.updateListingStock(v.listing_id, 0)
        } else {
          await this.mlService.updateListingStock(v.listing_id, qty)
        }
        confirmedQty = qty
        status       = 'success'
        httpStatus   = 200
      } catch (e: any) {
        status     = 'error'
        errorMsg   = e.message ?? 'erro desconhecido'
        httpStatus = e.response?.status ?? 500
        this.logger.warn(`[stock.sync] ML error ${v.listing_id}:`, errorMsg)
      }

      await supabaseAdmin.from('stock_sync_logs').insert({
        product_id:         productId,
        channel:            'mercadolivre',
        listing_id:         v.listing_id,
        sent_quantity:      qty,
        confirmed_quantity: confirmedQty,
        status,
        error_message:      errorMsg,
        http_status:        httpStatus,
        triggered_by:       triggeredBy,
        duration_ms:        Date.now() - startTime,
      })

      if (status === 'success' && distributionId) {
        await supabaseAdmin
          .from('channel_stock_distribution')
          .update({ last_published_qty: qty, last_synced_at: new Date().toISOString() })
          .eq('id', distributionId)
      }
    }
  }

  // ── Sync logs ─────────────────────────────────────────────────────────────

  async getSyncLogs(filters: {
    status?: string
    channel?: string
    since?: string
    limit?: number
  }) {
    let q = supabaseAdmin
      .from('stock_sync_logs')
      .select('*, product:products(name, sku)')
      .order('created_at', { ascending: false })
      .limit(filters.limit ?? 200)

    if (filters.status && filters.status !== 'all') q = q.eq('status', filters.status)
    if (filters.channel) q = q.eq('channel', filters.channel)
    if (filters.since)   q = q.gte('created_at', filters.since)

    const { data } = await q
    return data ?? []
  }

  async getSyncLogsSummary() {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    const { data: logs } = await supabaseAdmin
      .from('stock_sync_logs')
      .select('status')
      .gte('created_at', since24h)

    const all        = logs?.length ?? 0
    const success    = logs?.filter(l => l.status === 'success').length ?? 0
    const errors     = logs?.filter(l => l.status === 'error').length ?? 0
    const divergent  = logs?.filter(l => l.status === 'divergent').length ?? 0

    return {
      total_24h:    all,
      success_rate: all > 0 ? Math.round((success / all) * 100) : 100,
      errors,
      divergent,
    }
  }
}
