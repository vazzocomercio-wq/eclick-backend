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
    no_stock_record?: true
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
        no_stock_record: true,
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
        account_id:      null, // column doesn't exist on this table; kept in shape for future per-account distribution
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
    // onConflict was 'product_id,channel,account_id' but account_id doesn't
    // exist on this table — the conflict resolver was effectively disabled,
    // which would create duplicate rows on a second save for the same
    // (product, channel). Use the real composite key instead.
    const { data: result, error } = await supabaseAdmin
      .from('channel_stock_distribution')
      .upsert(
        { ...data, is_active: true, updated_at: new Date().toISOString() },
        { onConflict: 'product_id,channel' },
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

  async syncAllProductsWithMlListing(): Promise<{ total: number; success: number; errors: number }> {
    this.logger.log('[stock.sync-all] buscando produtos com vínculo ML ativo')
    const { data: vinculos, error } = await supabaseAdmin
      .from('product_listings')
      .select('product_id')
      .eq('platform', 'mercadolivre')
      .eq('is_active', true)

    if (error) {
      this.logger.error(`[stock.sync-all] query failed: ${error.message}`)
      throw new Error(error.message)
    }

    const productIds = [...new Set((vinculos ?? []).map(v => v.product_id as string))]
    this.logger.log(`[stock.sync-all] ${productIds.length} produto(s) único(s) para sincronizar`)

    let success = 0, errors = 0
    for (const productId of productIds) {
      try {
        await this.syncStockToAllChannels(productId, 'manual_sync_all')
        success++
      } catch (e: any) {
        errors++
        this.logger.error(`[stock.sync-all] erro produto ${productId}: ${e?.message}`)
      }
    }

    return { total: productIds.length, success, errors }
  }

  async syncStockToAllChannels(productId: string, triggeredBy = 'system_distribution') {
    console.log(`[STOCK-SYNC] >>> INICIO sync para produto ${productId} (trigger=${triggeredBy})`)
    try {
      const channelQtys = await this.calculateChannelQuantities(productId)
      console.log(`[STOCK-SYNC] canais retornados: ${JSON.stringify(channelQtys)}`)

      if (!channelQtys || channelQtys.length === 0) {
        console.log(`[STOCK-SYNC] nenhum canal retornado, abortando`)
        return
      }

      for (const cq of channelQtys) {
        console.log(`[STOCK-SYNC] iterando canal: ${cq.channel} qty:${cq.qty}`)
        if (cq.channel === 'mercadolivre') {
          console.log(`[STOCK-SYNC] >>> CHAMANDO syncToMl para ${productId}`)
          await this.syncToMl(productId, cq.qty, cq.should_pause, cq.distribution_id, triggeredBy)
          console.log(`[STOCK-SYNC] <<< syncToMl RETORNOU para ${productId}`)
        } else {
          console.log(`[STOCK-SYNC] canal ${cq.channel} ignorado (não suportado)`)
        }
      }

      console.log(`[STOCK-SYNC] <<< FIM sync para produto ${productId}`)
    } catch (e: any) {
      console.error(`[STOCK-SYNC] ERRO GERAL produto=${productId}:`, e?.message, e?.stack)
      throw e
    }
  }

  async syncToMl(
    productId: string,
    qty: number,
    shouldPause: boolean,
    distributionId: string | null = null,
    triggeredBy = 'system_distribution',
  ) {
    console.log(`[STOCK-ML] === INICIO === productId:${productId} qty:${qty} pause:${shouldPause} trigger:${triggeredBy}`)

    // Skip products without a product_stock row — without it qty was being
    // silently treated as 0, which would erase the listing's actual quantity
    // on ML. Better to log "ignored" and require an explicit stock record.
    const calc = await this.calculateAvailable(productId)
    if (calc.no_stock_record) {
      console.log(`[STOCK-ML] productId=${productId} sem registro em product_stock — abortando sync`)
      const { error: insErr } = await supabaseAdmin.from('stock_sync_logs').insert({
        product_id:    productId,
        channel:       'mercadolivre',
        sent_quantity: 0,
        status:        'ignored',
        error_message: 'Produto sem registro de estoque cadastrado',
        triggered_by:  triggeredBy,
      })
      if (insErr) console.error(`[STOCK-ML] erro ao inserir log no_stock_record: ${insErr.message}`)
      return
    }

    try {
      const { data: vinculos, error: vincErr } = await supabaseAdmin
        .from('product_listings')
        .select('listing_id')
        .eq('product_id', productId)
        .eq('platform', 'mercadolivre')
        .eq('is_active', true)

      console.log(`[STOCK-ML] vínculos encontrados: ${vinculos?.length ?? 0}${vincErr ? ' err:' + vincErr.message : ''}`)

      if (!vinculos?.length) {
        console.log(`[STOCK-ML] sem vínculos, salvando log "ignored"`)
        const { error: insErr } = await supabaseAdmin.from('stock_sync_logs').insert({
          product_id:    productId,
          channel:       'mercadolivre',
          sent_quantity: qty,
          status:        'ignored',
          error_message: 'Produto sem anúncios vinculados',
          triggered_by:  triggeredBy,
        })
        console.log(`[STOCK-ML] insert "ignored": ${insErr ? 'ERRO ' + insErr.message : 'ok'}`)
        return
      }

      for (const v of vinculos) {
        console.log(`[STOCK-ML] processando vínculo: ${v.listing_id}`)
        const startTime = Date.now()
        let status: string = 'pending'
        let errorMsg: string | null = null
        let httpStatus = 0
        let confirmedQty: number | null = null

        try {
          console.log(`[STOCK-ML] chamando ML PUT (${shouldPause ? 'pause→0' : qty})...`)
          await this.mlService.updateListingStock(v.listing_id, shouldPause ? 0 : qty)
          confirmedQty = shouldPause ? 0 : qty
          status       = 'success'
          httpStatus   = 200
          console.log(`[STOCK-ML] ML respondeu: ${confirmedQty}`)
        } catch (e: any) {
          status     = 'error'
          errorMsg   = e?.message ?? 'erro desconhecido'
          httpStatus = e?.response?.status ?? 500
          console.error(`[STOCK-ML] ML ERRO ${v.listing_id}: ${errorMsg}`)
        }

        console.log(`[STOCK-ML] inserindo log final: status=${status}`)
        const { error: logErr } = await supabaseAdmin.from('stock_sync_logs').insert({
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

        if (logErr) console.error(`[STOCK-ML] ERRO ao inserir log: ${logErr.message}`)
        else        console.log(`[STOCK-ML] log inserido OK`)

        if (status === 'success' && distributionId) {
          await supabaseAdmin
            .from('channel_stock_distribution')
            .update({ last_published_qty: qty, last_synced_at: new Date().toISOString() })
            .eq('id', distributionId)
        }
      }

      console.log(`[STOCK-ML] === FIM === productId:${productId}`)
    } catch (e: any) {
      console.error(`[STOCK-ML] ERRO GERAL productId=${productId}:`, e?.message, e?.stack)
    }
  }

  // ── Auto distribution (multichannel) ──────────────────────────────────────

  /**
   * Pre-flight check: can this product use distribution_mode='auto'?
   * Auto requires ≥2 active channels, all integrated (OAuth connected),
   * and at least one channel with sales in the last 30 days.
   */
  async canUseAutoMode(productId: string): Promise<{
    can_use: boolean
    reason?: string
    ready_channels: string[]
    missing_integration: string[]
    missing_sales_data: string[]
  }> {
    console.log(`[auto-check] productId=${productId}`)

    // Note: account_id removed from SELECT — column doesn't exist on
    // channel_stock_distribution; previous version errored silently and
    // returned data=null, falling into the "Nenhum canal cadastrado" branch
    // even when there were perfectly good rows in the table.
    const { data: distributions, error } = await supabaseAdmin
      .from('channel_stock_distribution')
      .select('channel, is_active, distribution_mode')
      .eq('product_id', productId)
      .eq('is_active', true)

    console.log(`[auto-check] rows=${distributions?.length ?? 0} err=${error?.message ?? 'none'} data=${JSON.stringify(distributions)}`)

    if (!distributions?.length) {
      return {
        can_use: false,
        reason: 'Nenhum canal cadastrado na distribuição',
        ready_channels: [],
        missing_integration: [],
        missing_sales_data: [],
      }
    }

    if (distributions.length < 2) {
      return {
        can_use: false,
        reason: 'Modo auto requer pelo menos 2 canais para distribuir',
        ready_channels: distributions.map(d => d.channel as string),
        missing_integration: [],
        missing_sales_data: [],
      }
    }

    const distChannels = distributions.map(d => d.channel as string)
    const { data: channels } = await supabaseAdmin
      .from('marketplace_channels')
      .select('id, is_integrated, integration_status')
      .in('id', distChannels)

    const channelMap = new Map<string, { is_integrated: boolean; integration_status: string | null }>(
      (channels ?? []).map(c => [c.id as string, { is_integrated: !!c.is_integrated, integration_status: c.integration_status as string | null }]),
    )

    const missing_integration: string[] = []
    const ready_channels: string[] = []

    for (const d of distributions) {
      const ch = channelMap.get(d.channel as string)
      if (!ch?.is_integrated || ch.integration_status !== 'connected') {
        missing_integration.push(d.channel as string)
      } else {
        ready_channels.push(d.channel as string)
      }
    }

    if (missing_integration.length > 0) {
      return {
        can_use: false,
        reason: `Canais não integrados: ${missing_integration.join(', ')}`,
        ready_channels,
        missing_integration,
        missing_sales_data: [],
      }
    }

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const { data: snapshots } = await supabaseAdmin
      .from('product_sales_snapshots')
      .select('platform, qty_sold')
      .eq('product_id', productId)
      .gte('snapshot_date', since)

    const salesByChannel = new Map<string, number>()
    for (const s of snapshots ?? []) {
      const ch = s.platform as string
      salesByChannel.set(ch, (salesByChannel.get(ch) ?? 0) + Number(s.qty_sold ?? 0))
    }

    const missing_sales_data: string[] = []
    for (const ch of ready_channels) {
      if (!salesByChannel.has(ch) || salesByChannel.get(ch) === 0) missing_sales_data.push(ch)
    }

    if (missing_sales_data.length === ready_channels.length) {
      return {
        can_use: false,
        reason: 'Nenhum canal tem vendas nos últimos 30 dias',
        ready_channels,
        missing_integration: [],
        missing_sales_data,
      }
    }

    return {
      can_use: true,
      ready_channels,
      missing_integration: [],
      // Channels without sales still get the floor (10%)
      missing_sales_data,
    }
  }

  /** Compute target percentages from last 30d sales, with 10% floor per channel. */
  async calculateAutoDistribution(productId: string): Promise<{
    ok: boolean
    message?: string
    distribution?: { channel: string; percentage: number }[]
  }> {
    const check = await this.canUseAutoMode(productId)
    if (!check.can_use) return { ok: false, message: check.reason }

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const { data: snapshots } = await supabaseAdmin
      .from('product_sales_snapshots')
      .select('platform, qty_sold')
      .eq('product_id', productId)
      .gte('snapshot_date', since)
      .in('platform', check.ready_channels)

    const salesByChannel = new Map<string, number>()
    for (const ch of check.ready_channels) salesByChannel.set(ch, 0)
    for (const s of snapshots ?? []) {
      const ch = s.platform as string
      salesByChannel.set(ch, (salesByChannel.get(ch) ?? 0) + Number(s.qty_sold ?? 0))
    }

    const totalSales = Array.from(salesByChannel.values()).reduce((s, v) => s + v, 0)

    if (totalSales === 0) {
      const equalPct = Math.floor(100 / check.ready_channels.length)
      const distribution = check.ready_channels.map(ch => ({ channel: ch, percentage: equalPct }))
      // Round-off into the first channel so we hit 100
      const total = distribution.reduce((s, d) => s + d.percentage, 0)
      if (total !== 100 && distribution.length) distribution[0].percentage += (100 - total)
      return { ok: true, distribution }
    }

    const FLOOR = 10
    const distribution: { channel: string; percentage: number }[] = []
    for (const ch of check.ready_channels) {
      const vendas = salesByChannel.get(ch) ?? 0
      let pct = Math.round((vendas / totalSales) * 100)
      if (pct < FLOOR) pct = FLOOR
      distribution.push({ channel: ch, percentage: pct })
    }

    // Normalize to sum 100 by adjusting the channel with most sales
    const total = distribution.reduce((s, d) => s + d.percentage, 0)
    if (total !== 100) {
      const sorted = [...distribution].sort(
        (a, b) => (salesByChannel.get(b.channel) ?? 0) - (salesByChannel.get(a.channel) ?? 0),
      )
      sorted[0].percentage += (100 - total)
    }

    return { ok: true, distribution }
  }

  /** Apply the calculated auto distribution + log + re-sync ML. */
  async applyAutoDistribution(productId: string, triggeredBy = 'user_manual') {
    console.log(`[stock.auto] iniciando recálculo product_id=${productId} trigger=${triggeredBy}`)
    const result = await this.calculateAutoDistribution(productId)

    if (!result.ok || !result.distribution) {
      console.log(`[stock.auto] não aplicado: ${result.message}`)
      // Audit even when skipped, so the user sees why
      await supabaseAdmin.from('distribution_recalc_log').insert({
        product_id:           productId,
        triggered_by:         triggeredBy,
        channels_considered:  null,
        channels_skipped:     [{ reason: result.message }],
        result:               null,
        applied:              false,
      })
      return result
    }

    const { data: oldDist } = await supabaseAdmin
      .from('channel_stock_distribution')
      .select('channel, percentage')
      .eq('product_id', productId)
      .eq('is_active', true)

    const oldMap = new Map<string, number>(
      (oldDist ?? []).map(d => [d.channel as string, Number(d.percentage ?? 0)]),
    )

    for (const d of result.distribution) {
      const { error: updErr } = await supabaseAdmin
        .from('channel_stock_distribution')
        .update({
          percentage:        d.percentage,
          distribution_mode: 'auto',
          updated_at:        new Date().toISOString(),
        })
        .eq('product_id', productId)
        .eq('channel', d.channel)
      if (updErr) console.error(`[stock.auto] update falhou ${d.channel}: ${updErr.message}`)
    }

    await supabaseAdmin.from('distribution_recalc_log').insert({
      product_id:           productId,
      triggered_by:         triggeredBy,
      channels_considered:  result.distribution,
      channels_skipped:     null,
      result:               result.distribution.map(d => ({
        channel: d.channel,
        old_pct: oldMap.get(d.channel) ?? 0,
        new_pct: d.percentage,
      })),
      applied:              true,
    })

    this.syncStockToAllChannels(productId, `auto_recalc_${triggeredBy}`)
      .catch(e => console.error('[stock.auto] sync erro:', e?.message))

    console.log(`[stock.auto] aplicado para ${productId}:`, result.distribution)
    return result
  }

  async getRecalcHistory(productId: string) {
    const { data, error } = await supabaseAdmin
      .from('distribution_recalc_log')
      .select('id, triggered_by, channels_considered, channels_skipped, result, applied, created_at')
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) {
      this.logger.warn(`[stock.auto] history failed: ${error.message}`)
      return []
    }
    return data ?? []
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
      .select('*, product:products(id, name, sku)')
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
