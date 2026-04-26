import { Injectable, UnauthorizedException, HttpException, BadRequestException, NotFoundException } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'

// redeploy - organization_id now nullable
const ML_BASE = 'https://api.mercadolibre.com'
const ML_AUTH = 'https://auth.mercadolivre.com.br'

export interface MlTokens {
  access_token: string
  refresh_token: string
  expires_at: number // unix ms
  seller_id: number
}

interface MlConnection {
  id?: string
  organization_id: string
  seller_id: number
  access_token: string
  refresh_token: string
  expires_at: string
  nickname: string | null
  created_at?: string
}

@Injectable()
export class MercadolivreService {
  // ── OAuth ────────────────────────────────────────────────────────────────

  getAuthUrl(redirectUri: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.ML_CLIENT_ID!,
      redirect_uri: redirectUri,
    })
    return `${ML_AUTH}/authorization?${params.toString()}`
  }

  async connect(orgId: string, code: string, redirectUri: string): Promise<{ seller_id: number; nickname: string }> {
    // ML connect logs are kept off in production — only errors below are logged.

    const tokenRes = await axios.post<{
      access_token: string
      refresh_token: string
      expires_in: number
      user_id: number
    }>(
      `${ML_BASE}/oauth/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.ML_CLIENT_ID!,
        client_secret: process.env.ML_CLIENT_SECRET!,
        code,
        redirect_uri: redirectUri,
      }),
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    ).catch((err: any) => {
      const mlError = err.response?.data
      console.error('[ML connect] token exchange failed:', mlError ?? err.message)
      throw new HttpException(
        mlError?.message ?? mlError?.error ?? err.message ?? 'Token exchange failed',
        err.response?.status ?? 500,
      )
    })

    const { access_token, refresh_token, expires_in, user_id } = tokenRes.data
    const expires_at = Date.now() + expires_in * 1000

    let nickname = `Conta #${user_id}`
    await axios.get<{ nickname?: string; first_name?: string }>(
      `${ML_BASE}/users/me`,
      { headers: { Authorization: `Bearer ${access_token}` } },
    ).then((r) => {
      nickname = r.data.nickname ?? r.data.first_name ?? nickname
    }).catch((err: any) => {
      console.warn('[ML connect] /users/me failed (non-fatal):', err.message)
    })

    // Delete existing row for this seller then insert fresh
    await supabaseAdmin.from('ml_connections').delete().eq('seller_id', user_id)

    const { error: dbError } = await supabaseAdmin.from('ml_connections').insert({
      organization_id: orgId,
      seller_id: user_id,
      access_token,
      refresh_token,
      expires_at: new Date(expires_at).toISOString(),
      nickname,
    })
    if (dbError) {
      console.error('[ML connect] db insert failed:', dbError.message)
      throw new HttpException(dbError.message, 500)
    }

    return { seller_id: user_id, nickname }
  }

  async disconnect(orgId: string, sellerId?: number): Promise<void> {
    if (sellerId) {
      await supabaseAdmin
        .from('ml_connections')
        .delete()
        .eq('organization_id', orgId)
        .eq('seller_id', sellerId)
    } else {
      await supabaseAdmin
        .from('ml_connections')
        .delete()
        .eq('organization_id', orgId)
    }
  }

  // Returns first connection (for backward compat with /ml/status)
  async getConnection(orgId: string) {
    const { data } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id, expires_at, access_token, nickname, organization_id')
      .eq('organization_id', orgId)
      .maybeSingle()

    if (data) return data

    const { data: fallback } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id, expires_at, access_token, nickname, organization_id')
      .limit(1)
      .maybeSingle()

    return fallback
  }

  // Returns all connections (safe — no tokens)
  async getConnections(_orgId: string) {
    const { data } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id, expires_at, nickname, created_at, organization_id')
      .order('created_at', { ascending: true })
    return data || []
  }

  // ── Multi-account helpers ─────────────────────────────────────────────────

  async getAllConnections(): Promise<MlConnection[]> {
    const { data } = await supabaseAdmin
      .from('ml_connections')
      .select('*')
      .order('created_at', { ascending: true })
    return (data || []) as MlConnection[]
  }

  private async refreshIfNeeded(
    conn: Pick<MlConnection, 'seller_id' | 'access_token' | 'refresh_token' | 'expires_at'>,
  ): Promise<string> {
    const isExpired = new Date(conn.expires_at).getTime() - Date.now() < 5 * 60 * 1000

    if (!isExpired) return conn.access_token

    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: conn.refresh_token,
        client_id: process.env.ML_CLIENT_ID!,
        client_secret: process.env.ML_CLIENT_SECRET!,
      })
      const response = await axios.post<{ access_token: string; refresh_token: string; expires_in: number }>(
        `${ML_BASE}/oauth/token`,
        params.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      )
      const { access_token, refresh_token, expires_in } = response.data
      const newExpiresAt = new Date(Date.now() + expires_in * 1000).toISOString()

      await supabaseAdmin
        .from('ml_connections')
        .update({ access_token, refresh_token, expires_at: newExpiresAt })
        .eq('seller_id', conn.seller_id)

      return access_token
    } catch (err: any) {
      const status = err?.response?.status ?? 'sem status'
      const body   = JSON.stringify(err?.response?.data ?? err?.message)
      console.error('[refreshIfNeeded] refresh FALHOU — seller:', conn.seller_id, '| status:', status, '| body:', body)
      throw new HttpException(`Token ML expirado e refresh falhou (${status})`, 401)
    }
  }

  async getValidToken(): Promise<{ token: string; sellerId: number }> {
    const connections = await this.getAllConnections()
    if (!connections.length) {
      console.error('[getValidToken] sem conexão ML no banco')
      throw new UnauthorizedException('ML não conectado')
    }
    const conn = connections[0]
    const token = await this.refreshIfNeeded(conn)
    return { token, sellerId: conn.seller_id }
  }

  async getTokenForOrg(orgId: string): Promise<{ token: string; sellerId: number }> {
    let { data: conn } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id, access_token, refresh_token, expires_at')
      .eq('organization_id', orgId)
      .maybeSingle()

    // Fallback: first available connection (solo-owner setup where org_id wasn't set on connect)
    if (!conn) {
      const { data: fallback } = await supabaseAdmin
        .from('ml_connections')
        .select('seller_id, access_token, refresh_token, expires_at')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      conn = fallback
    }

    if (!conn) throw new UnauthorizedException('ML não conectado para esta organização')
    const token = await this.refreshIfNeeded(conn as MlConnection)
    return { token, sellerId: conn.seller_id as number }
  }

  // ── Item info (for competitor lookup) ────────────────────────────────────
  // Uses ML public endpoint — no seller token required

  private extractMlbId(input: string): string | null {
    const cleaned = input.trim()
    if (/^MLB\d+$/i.test(cleaned)) return cleaned.toUpperCase()
    const patterns = [
      /MLB[UBub]?(\d+)/i,         // MLBU3911384208 or MLB3911384208
      /\/p\/MLB(\d+)/i,            // /p/MLB1234567
      /[-_]MLB(\d+)/i,             // -MLB1234567
      /item_id=MLB(\d+)/i,         // item_id=MLB1234567
      /[^\d](\d{8,12})(?:-_JM|#)/,// 12345678-_JM (numeric suffix only)
    ]
    for (const pattern of patterns) {
      const match = cleaned.match(pattern)
      if (match) {
        const id = match[1] ?? match[0]
        return id.toUpperCase().startsWith('MLB') ? id.toUpperCase() : `MLB${id}`
      }
    }
    return null
  }

  // Public fetch — no seller token. Safe to call for any MLB item.
  async getCompetitorItem(itemId: string): Promise<Record<string, unknown>> {
    try {
      const { data } = await axios.get(`${ML_BASE}/items/${itemId}`, {
        params: {
          attributes: 'id,title,price,available_quantity,sold_quantity,thumbnail,pictures,seller_id,shipping,listing_type_id,permalink,category_id',
        },
      })
      return data as Record<string, unknown>
    } catch (e: any) {
      console.error('[competitor] erro:', { status: e.response?.status, data: e.response?.data, itemId })
      throw new HttpException(
        e.response?.data?.message ?? `Não foi possível buscar o item ${itemId}`,
        e.response?.status ?? 500,
      )
    }
  }

  async getItemInfo(_orgId: string, url: string) {
    const mlbId = this.extractMlbId(url)

    if (!mlbId) {
      throw new BadRequestException(
        'Não foi possível extrair o ID do anúncio. ' +
        'Cole apenas o código MLB (ex: MLB6630158494) ou a URL completa do Mercado Livre.',
      )
    }

    const item = await this.getCompetitorItem(mlbId)

    let seller = `Vendedor #${item.seller_id}`
    await axios.get(`${ML_BASE}/users/${item.seller_id}`)
      .then((r: any) => { if (r.data?.nickname) seller = r.data.nickname })
      .catch(() => { /* non-fatal */ })

    return {
      title:     item.title     ?? null,
      price:     item.price     ?? null,
      seller,
      thumbnail: item.thumbnail ?? null,
      mlbId,
      permalink: item.permalink ?? null,
    }
  }

  // ── Vínculo preview ──────────────────────────────────────────────────────

  async getListingPreview(listingId: string) {
    const { token } = await this.getValidToken()
    const { data } = await axios.get(`${ML_BASE}/items/${listingId}`, {
      headers: { Authorization: `Bearer ${token}` },
      params:  { attributes: 'id,title,price,available_quantity,pictures,permalink,status' },
    })
    return {
      id:                 data.id              as string,
      title:              data.title           as string,
      price:              data.price           as number,
      available_quantity: data.available_quantity as number,
      thumbnail: (data.pictures?.[0]?.url ?? data.pictures?.[0]?.secure_url ?? null) as string | null,
      permalink:          data.permalink       as string,
      status:             data.status          as string,
    }
  }

  // ── Items ────────────────────────────────────────────────────────────────

  async getItems(orgId: string, offset = 0, limit = 50) {
    const { token, sellerId } = await this.getValidToken()

    const { data: search } = await axios.get(
      `${ML_BASE}/users/${sellerId}/items/search`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { offset, limit },
      },
    )

    if (!search.data.results?.length) return { items: [], total: search.data.paging?.total ?? 0 }

    const ids: string[] = search.data.results
    const { data: items } = await axios.get(
      `${ML_BASE}/items`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { ids: ids.join(','), attributes: 'id,title,price,available_quantity,thumbnail,status,permalink,sold_quantity' },
      },
    )

    return {
      items: items.data.map((r: any) => r.body ?? r),
      total: search.data.paging?.total ?? 0,
    }
  }

  async importItem(orgId: string, mlItemId: string): Promise<{ id: string }> {
    const { token } = await this.getValidToken()

    const { data: item } = await axios.get(`${ML_BASE}/items/${mlItemId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    const payload = {
      organization_id: orgId,
      status: 'active' as const,
      platforms: ['mercadolivre'],
      name: item.data.title,
      ml_title: item.data.title,
      price: item.data.price,
      stock: item.data.available_quantity,
      photo_urls: item.data.pictures?.map((p: any) => p.url) ?? null,
      condition: item.data.condition ?? 'new',
      ml_listing_type: item.data.listing_type_id ?? null,
      ml_free_shipping: item.data.shipping?.free_shipping ?? false,
      ml_item_id: mlItemId,
      attributes: {},
      fiscal: {},
    }

    const { data: inserted, error } = await supabaseAdmin
      .from('products')
      .insert(payload)
      .select('id')
      .single()

    if (error) throw new Error(error.message)
    return { id: inserted.id }
  }

  // ── Orders ───────────────────────────────────────────────────────────────

  async getOrders(orgId: string, offset = 0, limit = 50) {
    const { token, sellerId } = await this.getValidToken()

    const { data } = await axios.get(
      `${ML_BASE}/orders/search`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { seller: sellerId, offset, limit, sort: 'date_desc' },
      },
    )

    return { orders: data.results ?? [], total: data.paging?.total ?? 0 }
  }

  // ── Metrics ──────────────────────────────────────────────────────────────

  async getMetrics(orgId: string) {
    const { token, sellerId } = await this.getValidToken()

    const [visits, sales] = await Promise.all([
      axios.get(`${ML_BASE}/users/${sellerId}/items_visits`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { date_from: this.daysAgo(30), date_to: this.today() },
      }),
      axios.get(`${ML_BASE}/orders/search`, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          seller: sellerId,
          'order.status': 'paid',
          'order.date_created.from': this.daysAgo(30),
          limit: 1,
        },
      }),
    ])

    return {
      total_visits_30d: visits.data.data?.total_visits ?? 0,
      total_orders_30d: sales.data.data?.paging?.total ?? 0,
    }
  }

  private daysAgo(n: number): string {
    const d = new Date()
    d.setDate(d.getDate() - n)
    return d.toISOString().slice(0, 10) + 'T00:00:00.000-03:00'
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10) + 'T23:59:59.999-03:00'
  }

  // ── Pipeline endpoints ───────────────────────────────────────────────────

  async getMyItems(orgId: string) {
    const { token, sellerId } = await this.getValidToken()
    const { data: body } = await axios.get(`${ML_BASE}/users/${sellerId}/items/search`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { status: 'active', limit: 50 },
    })
    return { items: body.results ?? [], total: body.paging?.total ?? 0 }
  }

  async getCategory(id: string) {
    try {
      const { data } = await axios.get<{ id: string; name: string; path_from_root: Array<{ id: string; name: string }> }>(
        `${ML_BASE}/categories/${id}`,
      )
      return data
    } catch {
      return { id, name: id, path_from_root: [] }
    }
  }

  async getItemDetail(orgId: string, mlbId: string) {
    const { token } = await this.getValidToken()
    const { data: item } = await axios.get(`${ML_BASE}/items/${mlbId}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch((err: any) => {
      throw new HttpException(err.response?.data?.message ?? `ML ${err.response?.status ?? 500}`, err.response?.status ?? 500)
    })
    return {
      id: item.id, title: item.title, price: item.price,
      available_quantity: item.available_quantity, sold_quantity: item.sold_quantity,
      condition: item.condition, thumbnail: item.thumbnail,
      permalink: item.permalink, category_id: item.category_id,
      listing_type_id: item.listing_type_id,
    }
  }

  async getItemVisits(orgId: string, mlbId: string) {
    const { token } = await this.getValidToken()
    const { data: body } = await axios.get(`${ML_BASE}/items/${mlbId}/visits/time_window`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { last: 7, unit: 'day' },
    }).catch((err: any) => {
      throw new HttpException(err.response?.data?.message ?? `ML ${err.response?.status ?? 500}`, err.response?.status ?? 500)
    })
    return { total_visits: body.total_visits ?? 0, date_from: body.date_from ?? null, date_to: body.date_to ?? null }
  }

  // ── Shared helpers for getRecentOrders ───────────────────────────────────────

  private async _fetchShipments(token: string, orders: any[]): Promise<Record<number, any>> {
    // Fetch up to 40 shipments (parallel); ML rate-limit is lenient for reads
    const ids = [...new Set(
      orders.slice(0, 40).map((o: any) => o.shipping?.id).filter(Boolean)
    )] as number[]
    const map: Record<number, any> = {}
    if (!ids.length) return map
    const results = await Promise.allSettled(
      ids.map(id => axios.get(`${ML_BASE}/shipments/${id}`, { headers: { Authorization: `Bearer ${token}` } }))
    )
    let failed = 0
    ids.forEach((id, i) => {
      if (results[i].status === 'fulfilled') {
        map[id] = (results[i] as PromiseFulfilledResult<any>).value.data
      } else {
        failed++
      }
    })
    if (failed > 0) console.warn(`[shipments] ${failed}/${ids.length} fetches failed`)
    return map
  }

  private _mapOrder(o: any, shipMap: Record<number, any>) {
    const ship = shipMap[o.shipping?.id] ?? null
    const stateId: string = ship?.receiver_address?.state?.id ?? ''
    // ML returns "BR-SP" — extract "SP"
    const uf = stateId.startsWith('BR-') ? stateId.slice(3) : (stateId.length === 2 ? stateId : null)
    return {
      id: o.id,
      status: o.status,
      date_created: o.date_created,
      total_amount: o.total_amount,
      items: (o.order_items ?? []).map((i: any) => ({
        item_id: i.item?.id,
        title: i.item?.title,
        quantity: i.quantity,
        unit_price: i.unit_price,
      })),
      shipping_state: uf,
      shipping_city: ship?.receiver_address?.city?.name ?? null,
    }
  }

  // Fetches up to 500 orders via paginated calls (50/page, ML API limit with date filters).
  // Build URLs manually to avoid axios percent-encoding colons in ISO 8601 datetimes.
  private async _fetchAllOrders(
    token: string,
    sellerId: number,
    dateFrom?: string,
    dateTo?: string,
    withSort = true,
  ): Promise<{ results: any[]; total: number }> {
    const allOrders: any[] = []
    let pageOffset = 0
    let total: number | null = null
    let pageResults: any[] = []

    do {
      let url = `${ML_BASE}/orders/search?seller=${sellerId}&limit=50&offset=${pageOffset}`
      if (withSort) url += '&sort=date_desc'
      if (dateFrom) url += `&order.date_created.from=${dateFrom}T00:00:00.000-03:00`
      if (dateTo)   url += `&order.date_created.to=${dateTo}T23:59:59.999-03:00`

      const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } })
      pageResults = data?.results ?? []
      if (total === null) total = data?.paging?.total ?? 0

      allOrders.push(...pageResults)
      pageOffset += 50
    } while (
      pageResults.length === 50 &&
      allOrders.length < (total ?? 0) &&
      pageOffset < 500  // hard cap: 10 pages = 500 orders max
    )

    return { results: allOrders, total: total ?? 0 }
  }

  async getRecentOrders(orgId: string, offset = 0, limit = 50, dateFrom?: string, dateTo?: string) {
    let token: string
    let sellerId: number
    try {
      ;({ token, sellerId } = await this.getValidToken())
    } catch (authErr: any) {
      console.error('[recent-orders] getValidToken failed:', authErr?.message ?? authErr)
      throw new HttpException('ML não conectado — verifique a integração', 401)
    }

    try {
      const { results: rawOrders, total } = await this._fetchAllOrders(token, sellerId, dateFrom, dateTo, true)
      const shipMap = await this._fetchShipments(token, rawOrders)
      // Fire-and-forget: decrement stock for new paid/shipped orders
      this.processOrdersStock(rawOrders).catch((e: Error) =>
        console.error('[stock-sync] processOrdersStock falhou:', e.message),
      )
      return {
        orders: rawOrders.map((o: any) => this._mapOrder(o, shipMap)),
        total,
      }
    } catch (err: any) {
      const mlStatus = err?.response?.status ?? 500
      const mlData   = err?.response?.data
      console.error('[recent-orders] ML error', mlStatus, mlData?.message ?? '')

      if (mlStatus === 400) {
        console.warn('[recent-orders] 400 — retrying without sort')
        try {
          const { results: rawOrders2, total: total2 } = await this._fetchAllOrders(token, sellerId, dateFrom, dateTo, false)
          const shipMap2 = await this._fetchShipments(token, rawOrders2)
          return {
            orders: rawOrders2.map((o: any) => this._mapOrder(o, shipMap2)),
            total: total2,
          }
        } catch (err2: any) {
          console.error('[recent-orders] fallback also failed:', err2?.response?.status, JSON.stringify(err2?.response?.data))
          return { orders: [], total: 0 }
        }
      }

      const mlMsg = mlData?.message ?? mlData?.error ?? err?.message ?? 'Erro ao buscar pedidos'
      throw new HttpException(mlMsg, mlStatus)
    }
  }

  // ── ML stock sync ────────────────────────────────────────────────────────

  async updateListingStock(listingId: string, newQuantity: number): Promise<void> {
    const { token } = await this.getValidToken()
    try {
      await axios.put(
        `${ML_BASE}/items/${listingId}`,
        { available_quantity: newQuantity },
        { headers: { Authorization: `Bearer ${token}` } },
      )
    } catch (e: any) {
      console.error(`[stock-sync] erro em ${listingId}:`, e.response?.data?.message ?? e.message)
      throw e
    }
  }

  /** @deprecated prefer StockService.syncStockToAllChannels (logs to stock_sync_logs).
   * Retained because decrementStock (sale webhook) cannot inject StockService
   * without a circular dep. This path now writes to stock_sync_logs too. */
  async syncStockToListings(productId: string, platformQty: number, triggeredBy = 'ml_order_decrement'): Promise<void> {
    const { data: vinculos } = await supabaseAdmin
      .from('product_listings')
      .select('listing_id')
      .eq('product_id', productId)
      .eq('is_active', true)
      .eq('platform', 'mercadolivre')

    if (!vinculos?.length) {
      await supabaseAdmin.from('stock_sync_logs').insert({
        product_id:    productId,
        channel:       'mercadolivre',
        sent_quantity: platformQty,
        status:        'ignored',
        error_message: 'Produto sem anúncios vinculados',
        triggered_by:  triggeredBy,
      })
      return
    }

    for (const v of vinculos as { listing_id: string }[]) {
      const startTime = Date.now()
      let status = 'pending', errorMsg: string | null = null, httpStatus = 0
      let confirmedQty: number | null = null
      try {
        await this.updateListingStock(v.listing_id, platformQty)
        confirmedQty = platformQty
        status = 'success'
        httpStatus = 200
      } catch (e: any) {
        status     = 'error'
        errorMsg   = e?.message ?? 'erro'
        httpStatus = e?.response?.status ?? 500
        console.error(`[stock-sync] falha em ${v.listing_id}: ${errorMsg}`)
      }

      await supabaseAdmin.from('stock_sync_logs').insert({
        product_id:         productId,
        channel:            'mercadolivre',
        listing_id:         v.listing_id,
        sent_quantity:      platformQty,
        confirmed_quantity: confirmedQty,
        status,
        error_message:      errorMsg,
        http_status:        httpStatus,
        triggered_by:       triggeredBy,
        duration_ms:        Date.now() - startTime,
      })
    }
  }

  // ── Auto stock decrement ─────────────────────────────────────────────────

  private async decrementStock(orderId: number, listingId: string, qtdVendida: number) {
    // Idempotency check
    const { data: existing } = await supabaseAdmin
      .from('stock_movements')
      .select('id')
      .eq('reference_type', 'ml_order')
      .eq('reference_id', String(orderId))
      .limit(1)
    if (existing?.length) return

    const { data: vinculos } = await supabaseAdmin
      .from('product_listings')
      .select('product_id, quantity_per_unit')
      .eq('listing_id', listingId)
      .eq('is_active', true)

    for (const vinculo of (vinculos ?? [])) {
      const qtdDecrementar = (vinculo.quantity_per_unit ?? 1) * qtdVendida

      const { data: stock } = await supabaseAdmin
        .from('product_stock')
        .select('id, quantity, virtual_quantity, auto_pause_enabled, min_stock_to_pause')
        .eq('product_id', vinculo.product_id)
        .is('platform', null)
        .maybeSingle()

      if (!stock) continue

      const novaQtd = Math.max(0, (stock.quantity ?? 0) - qtdDecrementar)

      await supabaseAdmin
        .from('product_stock')
        .update({ quantity: novaQtd, updated_at: new Date().toISOString() })
        .eq('id', stock.id)

      await supabaseAdmin.from('stock_movements').insert({
        product_id:     vinculo.product_id,
        stock_id:       stock.id,
        movement_type:  'sale',
        quantity:       qtdDecrementar,
        notes:          `Venda automática: ${qtdVendida} un. anúncio ${listingId}`,
        reference_type: 'ml_order',
        reference_id:   String(orderId),
        balance_after:  novaQtd,
      })

      const platformQty = novaQtd + (stock.virtual_quantity ?? 0)

      // Sincronizar com ML (fire-and-forget)
      this.syncStockToListings(vinculo.product_id, platformQty)
        .catch((e: Error) => console.error('[stock-sync] decrementStock sync falhou:', e.message))

      // Pausa automática: (físico + virtual) ≤ mínimo
      if (stock.auto_pause_enabled && platformQty <= (stock.min_stock_to_pause ?? 0)) {
        await supabaseAdmin
          .from('products')
          .update({ status: 'paused' })
          .eq('id', vinculo.product_id)
      }
    }
  }

  private async processOrdersStock(orders: any[]) {
    const toProcess = orders
      .filter((o: any) => o.status === 'paid' || o.status === 'shipped')
      .slice(0, 50)
    for (const order of toProcess) {
      for (const item of (order.order_items ?? [])) {
        const listingId = item.item?.id
        const qty       = item.quantity ?? 1
        if (listingId) {
          await this.decrementStock(order.id, listingId, qty)
            .catch((e: Error) => console.error(`[stock] order ${order.id}:`, e.message))
        }
      }
    }
  }

  async getCatalogCompetitors(orgId: string, catalogId: string) {
    const { token } = await this.getValidToken()
    const { data: body } = await axios.get(`${ML_BASE}/products/${catalogId}/items`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { status: 'active' },
    }).catch((err: any) => {
      throw new HttpException(err.response?.data?.message ?? `ML ${err.response?.status ?? 500}`, err.response?.status ?? 500)
    })
    return body
  }

  async getSellerInfo(orgId: string) {
    const { token, sellerId } = await this.getValidToken()
    const { data: user } = await axios.get(`${ML_BASE}/users/${sellerId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return {
      seller_id: sellerId,
      nickname: user.nickname ?? null,
      registration_date: user.registration_date ?? null,
      country_id: user.country_id ?? null,
      seller_reputation: user.seller_reputation ?? null,
      metrics: user.metrics ?? null,
    }
  }

  async getReputation(orgId: string) {
    try {
      const { token: accessToken } = await this.getValidToken()

      const response = await axios.get(`${ML_BASE}/users/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      const rep = response.data?.seller_reputation
      return rep || {}
    } catch (error: any) {
      console.error('[reputation] erro:', error?.response?.status, error?.message)
      return {}
    }
  }

  private async fetchQuestionsRaw(token: string, sellerId: number, status = 'UNANSWERED'): Promise<{ questions: any[]; total: number }> {
    // Primary: /questions/search?seller_id=...
    const primaryUrl = `${ML_BASE}/questions/search?seller_id=${sellerId}&status=${status}&limit=50`
    try {
      const { data } = await axios.get(primaryUrl, { headers: { Authorization: `Bearer ${token}` } })
      return { questions: data?.questions ?? [], total: data?.total ?? 0 }
    } catch (err: any) {
      const httpStatus = err?.response?.status ?? 500
      if (httpStatus !== 403 && httpStatus !== 404) throw err
      // Silent fallback for 403/404 — try legacy endpoint
    }

    // Fallback: /my/received_questions
    const fallbackUrl = `${ML_BASE}/my/received_questions?status=${status}&limit=50`
    const { data: fb } = await axios.get(fallbackUrl, { headers: { Authorization: `Bearer ${token}` } })
    return { questions: fb?.questions ?? [], total: fb?.total ?? 0 }
  }

  async getQuestions(orgId: string, status = 'UNANSWERED') {
    try {
      const { token, sellerId } = await this.getValidToken()
      const { questions, total } = await this.fetchQuestionsRaw(token, sellerId, status)

      // Enrich with item data (batch up to 20 IDs per request)
      const itemIds = [...new Set(questions.map((q: any) => q.item_id).filter(Boolean))] as string[]
      const itemMap: Record<string, any> = {}
      for (let i = 0; i < itemIds.length; i += 20) {
        const chunk = itemIds.slice(i, i + 20)
        try {
          const { data: items } = await axios.get(`${ML_BASE}/items`, {
            headers: { Authorization: `Bearer ${token}` },
            params: { ids: chunk.join(',') },
          })
          for (const result of items) {
            if (result.code === 200 && result.body) {
              const b = result.body
              itemMap[b.id] = {
                id: b.id,
                title: b.title,
                thumbnail: b.thumbnail,
                price: b.price,
                available_quantity: b.available_quantity,
                seller_sku: b.seller_custom_field ?? null,
                permalink: b.permalink ?? null,
              }
            }
          }
        } catch { /* skip enrichment on error */ }
      }

      const enriched = questions.map((q: any) => ({
        ...q,
        item: itemMap[q.item_id] ?? null,
      }))

      return { questions: enriched, total, sellerId }
    } catch (err: any) {
      const httpStatus = err?.response?.status ?? 500
      console.error('[questions] ML error:', httpStatus, err?.response?.data?.message ?? err?.message)
      if (httpStatus === 403 || httpStatus === 404 || httpStatus === 401) return { questions: [], total: 0, sellerId: null }
      throw new HttpException(err?.response?.data?.message ?? err?.message ?? 'Erro ao buscar perguntas', httpStatus)
    }
  }

  async answerQuestion(orgId: string | null, questionId: number, text: string) {
    const { token } = await this.getValidToken()
    try {
      const { data } = await axios.post(
        `${ML_BASE}/answers`,
        { question_id: questionId, text },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
      )
      return data
    } catch (err: any) {
      const status = err?.response?.status ?? 500
      const mlMsg: string = err?.response?.data?.message ?? err?.response?.data?.error ?? err?.message ?? ''
      console.error('[answer] ML error:', status, mlMsg)

      // Translate common ML errors to clear Portuguese messages
      if (status === 400) {
        const lower = mlMsg.toLowerCase()
        if (lower.includes('already answered') || lower.includes('already have an answer')) {
          throw new HttpException('Esta pergunta já foi respondida', 400)
        }
        if (lower.includes('too short') || lower.includes('too long')) {
          throw new HttpException('Resposta com tamanho inválido para o ML', 400)
        }
        throw new HttpException(mlMsg || 'Dados inválidos', 400)
      }
      throw new HttpException(mlMsg || 'Erro ao responder pergunta', status)
    }
  }

  async getClaims(orgId: string) {
    try {
      const { token } = await this.getValidToken()
      const { data: body } = await axios.get(`${ML_BASE}/post-purchase/claims`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { role: 'seller', status: 'opened' },
      })
      return body
    } catch (err: any) {
      const status = err?.response?.status ?? 500
      // Expected for accounts without claims access — return empty silently.
      if (status === 401 || status === 403 || status === 404) return { data: [], total: 0 }
      console.error('[claims] ML error:', status, err?.response?.data?.message ?? err?.message)
      throw new HttpException(err?.response?.data?.message ?? err?.message ?? 'Erro ao buscar reclamações', status)
    }
  }

  // ── Catalog / Listings ───────────────────────────────────────────────────

  private async fetchListingsForAccount(
    sellerId: number,
    token: string,
    status: string,
    offset: number,
    limit: number,
    q?: string,
  ): Promise<{ items: any[]; total: number }> {
    const searchParams: Record<string, unknown> = { status, offset, limit }
    if (q?.trim()) searchParams.q = q.trim()

    const { data: search } = await axios.get(`${ML_BASE}/users/${sellerId}/items/search`, {
      headers: { Authorization: `Bearer ${token}` },
      params: searchParams,
    })

    const ids: string[] = search.results ?? []
    const total: number = search.paging?.total ?? 0

    if (ids.length === 0) return { items: [], total }

    const { data: multi } = await axios.get(`${ML_BASE}/items`, {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        ids: ids.join(','),
        attributes: [
          'id', 'title', 'price', 'original_price', 'available_quantity',
          'sold_quantity', 'thumbnail', 'permalink', 'status', 'listing_type_id',
          'catalog_product_id', 'catalog_listing', 'shipping', 'attributes',
          'variations', 'pictures', 'tags', 'last_updated', 'date_created',
          'category_id', 'deal_ids', 'promotions', 'seller_custom_field',
          'catalog_listing_type_id',
        ].join(','),
      },
    })

    const items = (Array.isArray(multi) ? multi : [])
      .filter((r: any) => r.code === 200)
      .map((r: any) => {
        const i = r.body
        return {
          id: i.id,
          title: i.title,
          price: i.price,
          original_price: i.original_price ?? null,
          available_quantity: i.available_quantity,
          sold_quantity: i.sold_quantity,
          thumbnail: i.thumbnail,
          permalink: i.permalink,
          status: i.status,
          listing_type_id: i.listing_type_id,
          catalog_product_id: i.catalog_product_id ?? null,
          catalog_listing: i.catalog_listing ?? false,
          catalog_listing_type_id: i.catalog_listing_type_id ?? null,
          free_shipping: i.shipping?.free_shipping ?? false,
          logistic_type: i.shipping?.logistic_type ?? null,
          sku: i.seller_custom_field
            ?? i.attributes?.find((a: any) => a.id === 'SELLER_SKU')?.value_name
            ?? null,
          has_variations: (i.variations?.length ?? 0) > 0,
          pictures_count: i.pictures?.length ?? 0,
          tags: i.tags ?? [],
          deal_ids: i.deal_ids ?? [],
          promotions: i.promotions ?? [],
          last_updated: i.last_updated,
          date_created: i.date_created,
          category_id: i.category_id,
          health_score: null as number | null,
          health_status: null as string | null,
          health_reasons: [] as string[],
        }
      })

    return { items, total }
  }

  async getListings(orgId: string, status = 'active', offset = 0, limit = 20, q?: string) {
    const connections = await this.getAllConnections()
    if (!connections.length) throw new UnauthorizedException('ML não conectado')

    let allItems: any[] = []
    let totalSum = 0

    for (const conn of connections) {
      try {
        const token = await this.refreshIfNeeded(conn)
        const { items, total } = await this.fetchListingsForAccount(
          conn.seller_id, token, status, offset, limit, q,
        )
        allItems = allItems.concat(items.map(i => ({
          ...i,
          account_nickname: conn.nickname ?? `Conta #${conn.seller_id}`,
          account_seller_id: conn.seller_id,
        })))
        totalSum += total
      } catch (err: any) {
        console.error('[getListings] erro para seller', conn.seller_id, err?.message)
      }
    }

    // Batch-check which items already have a linked product in the catalog
    if (allItems.length > 0) {
      const mlIds = allItems.map((i: any) => i.id)
      const { data: linked } = await supabaseAdmin
        .from('products')
        .select('ml_listing_id')
        .in('ml_listing_id', mlIds)
      const linkedSet = new Set((linked ?? []).map((r: any) => r.ml_listing_id as string))
      allItems = allItems.map((i: any) => ({ ...i, has_product: linkedSet.has(i.id) }))
    }

    return { items: allItems, total: totalSum }
  }

  async getListingsCounts(orgId: string) {
    const connections = await this.getAllConnections()
    const statuses = ['active', 'paused', 'closed', 'under_review']
    const counts: Record<string, number> = { active: 0, paused: 0, closed: 0, under_review: 0 }

    for (const conn of connections) {
      try {
        const token = await this.refreshIfNeeded(conn)
        const results = await Promise.allSettled(
          statuses.map(s => axios.get(`${ML_BASE}/users/${conn.seller_id}/items/search`, {
            headers: { Authorization: `Bearer ${token}` },
            params: { status: s, limit: 1 },
          }))
        )
        statuses.forEach((s, i) => {
          const r = results[i]
          if (r.status === 'fulfilled') counts[s] += r.value.data?.paging?.total ?? 0
        })
      } catch (err: any) {
        console.error('[getListingsCounts] erro para seller', conn.seller_id, err?.message)
      }
    }

    return counts
  }

  async getListingsVisits(orgId: string) {
    const { token, sellerId } = await this.getValidToken()

    const { data: search } = await axios.get(`${ML_BASE}/users/${sellerId}/items/search`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { status: 'active', limit: 20 },
    })

    const ids: string[] = (search.results ?? []).slice(0, 20)
    if (ids.length === 0) return { total: 0, byDay: [] }

    const results = await Promise.allSettled(
      ids.map((id: string) => axios.get(`${ML_BASE}/items/${id}/visits/time_window`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { last: 150, unit: 'day' },
      }))
    )

    const byDateMap: Record<string, number> = {}
    let total = 0

    for (const r of results) {
      if (r.status === 'fulfilled') {
        const body = r.value.data
        total += body.total_visits ?? 0
        for (const result of body.results ?? []) {
          const date: string = result.date?.substring(0, 10) ?? ''
          if (date) byDateMap[date] = (byDateMap[date] ?? 0) + (result.total ?? 0)
        }
      }
    }

    const byDay = Object.entries(byDateMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, visits]) => ({ date, visits }))

    return { total, byDay }
  }

  // ── Orders enriched ──────────────────────────────────────────────────────

  async getOrdersKpis(orgId: string) {
    const { token, sellerId } = await this.getValidToken()

    const now     = new Date()
    const curFrom = new Date(now.getFullYear(), now.getMonth(), 1)
    const prvFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const prvTo   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)
    const fmt     = (d: Date) => d.toISOString().slice(0, 19) + '.000-03:00'

    const [curRes, prvRes] = await Promise.allSettled([
      axios.get(`${ML_BASE}/orders/search`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { seller: sellerId, 'order.status': 'paid', 'order.date_created.from': fmt(curFrom), limit: 200, sort: 'date_asc' },
      }),
      axios.get(`${ML_BASE}/orders/search`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { seller: sellerId, 'order.status': 'paid', 'order.date_created.from': fmt(prvFrom), 'order.date_created.to': fmt(prvTo), limit: 200, sort: 'date_asc' },
      }),
    ])

    const aggregate = (orders: any[]) => {
      const byDay: Record<string, { count: number; revenue: number }> = {}
      let count = 0; let revenue = 0
      for (const o of orders) {
        const d = (o.date_created ?? '').substring(0, 10)
        if (d) {
          byDay[d] = byDay[d] ?? { count: 0, revenue: 0 }
          byDay[d].count++
          byDay[d].revenue += o.total_amount ?? 0
        }
        count++; revenue += o.total_amount ?? 0
      }
      return {
        count,
        revenue: Math.round(revenue * 100) / 100,
        by_day: Object.entries(byDay)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, { count: c, revenue: r }]) => ({ date, count: c, revenue: Math.round(r * 100) / 100 })),
      }
    }

    return {
      current_month: aggregate(curRes.status === 'fulfilled' ? curRes.value.data.results ?? [] : []),
      last_month:    aggregate(prvRes.status === 'fulfilled' ? prvRes.value.data.results ?? [] : []),
    }
  }

  async getOrdersEnriched(orgId: string, offset = 0, limit = 20, q?: string) {
    const { token, sellerId } = await this.getValidToken()

    const params: Record<string, unknown> = { seller: sellerId, sort: 'date_desc', limit, offset }
    if (q?.trim()) params.q = q.trim()

    const { data: body } = await axios.get(`${ML_BASE}/orders/search`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
    }).catch((err: any) => {
      throw new HttpException(err?.response?.data?.message ?? 'Erro ao buscar pedidos', err?.response?.status ?? 500)
    })

    const orders: any[] = body.results ?? []

    // ── Shipping details + real seller costs in parallel ─────────────────
    const shipIds = [...new Set(orders.map((o: any) => o.shipping?.id).filter(Boolean))] as number[]
    const shipMap: Record<number, any> = {}
    const costsMap: Record<number, number> = {}

    if (shipIds.length > 0) {
      const [shipRes, costsRes] = await Promise.all([
        Promise.allSettled(
          shipIds.map(id => axios.get(`${ML_BASE}/shipments/${id}`, {
            headers: { Authorization: `Bearer ${token}` },
          }))
        ),
        Promise.allSettled(
          shipIds.map(id => axios.get(`${ML_BASE}/shipments/${id}/costs`, {
            headers: { Authorization: `Bearer ${token}` },
          }))
        ),
      ])

      shipIds.forEach((id, i) => {
        if (shipRes[i].status === 'fulfilled')   shipMap[id]  = (shipRes[i]  as any).value.data
        if (costsRes[i].status === 'fulfilled') costsMap[id] = (costsRes[i] as any).value.data?.senders?.[0]?.cost ?? 0
      })

    }

    // ── Item thumbnails in batch ──────────────────────────────────────────
    const itemIds = [...new Set(orders.flatMap((o: any) =>
      (o.order_items ?? []).map((i: any) => i.item?.id).filter(Boolean)
    ))] as string[]
    const thumbMap: Record<string, string> = {}
    if (itemIds.length > 0) {
      try {
        const { data: batchItems } = await axios.get(`${ML_BASE}/items`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { ids: itemIds.slice(0, 20).join(','), attributes: 'id,thumbnail,available_quantity' },
        })
        ;(Array.isArray(batchItems) ? batchItems : [])
          .filter((r: any) => r.code === 200)
          .forEach((r: any) => { if (r.body?.id) thumbMap[r.body.id] = r.body.thumbnail ?? '' })
      } catch { /* non-fatal */ }
    }

    // ── Product cost/tax lookup by SKU ───────────────────────────────────
    const skus = [...new Set(orders.flatMap((o: any) =>
      (o.order_items ?? []).map((i: any) => i.item?.seller_sku).filter(Boolean)
    ))] as string[]
    const productMap: Record<string, { cost_price: number | null; tax_percentage: number | null; tax_on_freight: boolean }> = {}
    if (skus.length > 0) {
      const { data: prods } = await supabaseAdmin
        .from('products')
        .select('sku, cost_price, tax_percentage, tax_on_freight')
        .in('sku', skus)
      ;(prods ?? []).forEach((p: any) => {
        if (p.sku) productMap[p.sku] = { cost_price: p.cost_price ?? null, tax_percentage: p.tax_percentage ?? null, tax_on_freight: p.tax_on_freight ?? false }
      })
    }

    const enriched = orders.map((o: any, idx: number) => {
      const ship        = shipMap[o.shipping?.id] ?? null
      const totalAmount: number = o.total_amount ?? 0

      // Tarifa: soma real dos sale_fee dos itens (fallback: 11,5%)
      const tarifaSaleFee = (o.order_items ?? []).reduce((s: number, i: any) => s + (i.sale_fee ?? 0), 0)
      const tarifaML      = tarifaSaleFee > 0
        ? Math.round(tarifaSaleFee * 100) / 100
        : Math.round(totalAmount * 0.115 * 100) / 100

      // Frete: custo real do vendedor via /shipments/{id}/costs → senders[0].cost
      const freteVendedor: number = o.shipping?.id != null
        ? (costsMap[o.shipping.id] ?? ship?.base_cost ?? 0)
        : 0

      const lucroBruto = Math.round((totalAmount - tarifaML - freteVendedor) * 100) / 100

      // product cost/tax for first item's SKU
      const firstSku = o.order_items?.[0]?.item?.seller_sku ?? null
      const prodData = firstSku ? (productMap[firstSku] ?? null) : null
      const costPrice: number | null   = prodData?.cost_price ?? null
      const taxPct: number | null      = prodData?.tax_percentage ?? null
      const taxOnFreight: boolean      = prodData?.tax_on_freight ?? false
      let taxAmount: number | null = null
      let contribMargin: number | null = null
      let contribMarginPct: number | null = null
      if (taxPct != null) {
        const taxBase = taxOnFreight ? totalAmount + freteVendedor : totalAmount
        taxAmount = Math.round(taxBase * (taxPct / 100) * 100) / 100
      }
      if (costPrice != null) {
        const cm = lucroBruto - (costPrice ?? 0) - (taxAmount ?? 0)
        contribMargin    = Math.round(cm * 100) / 100
        contribMarginPct = totalAmount > 0 ? Math.round((cm / totalAmount) * 10000) / 100 : 0
      }

      return {
        order_id:      o.id,
        status:        o.status,
        status_detail: o.status_detail ?? null,
        date_created:  o.date_created,
        date_closed:   o.date_closed ?? null,
        total_amount:  totalAmount,
        paid_amount:   o.paid_amount ?? totalAmount,
        buyer: {
          id:         o.buyer?.id ?? null,
          nickname:   o.buyer?.nickname ?? null,
          first_name: o.buyer?.first_name ?? null,
          last_name:  o.buyer?.last_name ?? null,
        },
        order_items: (o.order_items ?? []).map((i: any) => ({
          item_id:              i.item?.id ?? null,
          title:                i.item?.title ?? null,
          seller_sku:           i.item?.seller_sku ?? null,
          quantity:             i.quantity,
          unit_price:           i.unit_price,
          full_unit_price:      i.full_unit_price ?? i.unit_price,
          variation_id:         i.variation_id ?? null,
          variation_attributes: i.variation_attributes ?? [],
          thumbnail:            thumbMap[i.item?.id ?? ''] ?? null,
        })),
        shipping: {
          id:                     o.shipping?.id ?? null,
          status:                 ship?.status ?? null,
          substatus:              ship?.substatus ?? null,
          logistic_type:          ship?.logistic_type ?? null,
          date_created:           ship?.date_created ?? null,
          estimated_delivery_date: ship?.shipping_option?.estimated_delivery_time?.date ?? null,
          posting_deadline:       ship?.shipping_option?.estimated_delivery_time?.pay_before ?? null,
          receiver_address: {
            zip_code:      ship?.receiver_address?.zip_code ?? null,
            city:          ship?.receiver_address?.city?.name ?? null,
            state:         ship?.receiver_address?.state?.name ?? null,
            street_name:   ship?.receiver_address?.street_name ?? null,
            street_number: ship?.receiver_address?.street_number ?? null,
            neighborhood:  ship?.receiver_address?.neighborhood?.name ?? null,
            complement:    ship?.receiver_address?.complement ?? ship?.receiver_address?.apartment ?? null,
            address_line:  ship?.receiver_address?.address_line ?? null,
          },
          base_cost:        ship?.base_cost ?? 0,
          receiver_cost:    ship?.cost_components?.receiver_shipping_cost ?? null,
        },
        payments: (o.payments ?? []).map((p: any) => ({
          id:                p.id,
          total_paid_amount: p.total_paid_amount,
          installments:      p.installments ?? 1,
          payment_type:      p.payment_type,
          status:            p.status,
        })),
        tags:       o.tags ?? [],
        mediations: o.mediations ?? [],
        tarifa_ml:           tarifaML,
        frete_vendedor:      freteVendedor,
        lucro_bruto:         lucroBruto,
        cost_price:          costPrice,
        tax_amount:          taxAmount,
        contribution_margin: contribMargin,
        contribution_margin_pct: contribMarginPct,
      }
    })

    return { orders: enriched, total: body.paging?.total ?? 0 }
  }

  // ── Order Totals (lean aggregation — no orders kept in memory) ───────────────

  async getOrderTotals(
    orgId: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<{ total_revenue: number; total_orders: number; ml_total: number; average_ticket: number; date_from: string; date_to: string }> {
    let token: string
    let sellerId: number
    try {
      ;({ token, sellerId } = await this.getValidToken())
    } catch {
      throw new HttpException('ML não conectado', 401)
    }

    const from = dateFrom.slice(0, 10)
    const to   = dateTo.slice(0, 10)

    let totalRevenue    = 0
    let totalOrders     = 0
    let paginationTotal = 0
    let offset          = 0
    let pageResults: any[] = []

    do {
      const url =
        `${ML_BASE}/orders/search?seller=${sellerId}&sort=date_desc&limit=50&offset=${offset}` +
        `&order.date_created.from=${from}T00:00:00.000-03:00` +
        `&order.date_created.to=${to}T23:59:59.999-03:00`

      const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } })
      pageResults = data?.results ?? []

      if (offset === 0) paginationTotal = data?.paging?.total ?? 0

      for (const order of pageResults) {
        totalRevenue += order.total_amount ?? 0
        totalOrders++
      }

      offset += 50
    } while (pageResults.length === 50 && totalOrders < paginationTotal)

    return {
      total_revenue:  totalRevenue,
      total_orders:   totalOrders,
      ml_total:       paginationTotal,
      average_ticket: totalOrders > 0 ? totalRevenue / totalOrders : 0,
      date_from:      from,
      date_to:        to,
    }
  }

  // ── Financial Summary ─────────────────────────────────────────────────────

  async getFinancialSummary(
    orgId: string,
    dateFrom: string,
    dateTo: string,
    statusFilter?: string,
    kpisOnly = false,
  ) {
    const connections = await this.getAllConnections()
    if (!connections.length) throw new UnauthorizedException('ML não conectado')

    const fmt = (s: string) =>
      new Date(s).toISOString().slice(0, 19) + '.000-03:00'

    const allOrders: any[] = []

    for (const conn of connections) {
      const token = await this.refreshIfNeeded(conn)
      let offset = 0
      const perPage = 50
      const maxOrders = 500

      while (offset < maxOrders) {
        const params: Record<string, unknown> = {
          seller: conn.seller_id,
          sort: 'date_desc',
          limit: perPage,
          offset,
          'order.date_created.from': fmt(dateFrom),
          'order.date_created.to': fmt(dateTo),
        }
        if (statusFilter && statusFilter !== 'all') {
          params['order.status'] = statusFilter
        }

        const { data: body } = await axios
          .get(`${ML_BASE}/orders/search`, {
            headers: { Authorization: `Bearer ${token}` },
            params,
          })
          .catch(() => ({ data: { results: [], paging: { total: 0 } } }))

        const results: any[] = body.results ?? []
        for (const o of results) {
          allOrders.push({
            ...o,
            _account_nickname: conn.nickname ?? `Conta #${conn.seller_id}`,
            _seller_id: conn.seller_id,
          })
        }
        offset += results.length
        if (results.length < perPage || offset >= (body.paging?.total ?? 0)) break
      }
    }

    // Shipments (only when full detail is needed)
    const shipMap: Record<number, any> = {}
    if (!kpisOnly) {
      const shipIds = [
        ...new Set(allOrders.map((o: any) => o.shipping?.id).filter(Boolean)),
      ] as number[]
      if (shipIds.length > 0) {
        const firstToken = await this.refreshIfNeeded(connections[0])
        const batchSize = 20
        for (let i = 0; i < shipIds.length; i += batchSize) {
          const batch = shipIds.slice(i, i + batchSize)
          const res = await Promise.allSettled(
            batch.map(id =>
              axios.get(`${ML_BASE}/shipments/${id}`, {
                headers: { Authorization: `Bearer ${firstToken}` },
              }),
            ),
          )
          batch.forEach((id, j) => {
            if (res[j].status === 'fulfilled')
              shipMap[id] = (res[j] as any).value.data
          })
        }
      }
    }

    // Product costs/tax
    const skus = [
      ...new Set(
        allOrders.flatMap((o: any) =>
          (o.order_items ?? [])
            .map((i: any) => i.item?.seller_sku)
            .filter(Boolean),
        ),
      ),
    ] as string[]
    const productMap: Record<string, any> = {}
    if (skus.length > 0) {
      const { data: prods } = await supabaseAdmin
        .from('products')
        .select('sku, cost_price, tax_percentage, tax_on_freight')
        .in('sku', skus)
      ;(prods ?? []).forEach((p: any) => {
        if (p.sku) productMap[p.sku] = p
      })
    }

    // Thumbnails (only full mode)
    const thumbMap: Record<string, string> = {}
    if (!kpisOnly) {
      const itemIds = [
        ...new Set(
          allOrders.flatMap((o: any) =>
            (o.order_items ?? []).map((i: any) => i.item?.id).filter(Boolean),
          ),
        ),
      ] as string[]
      if (itemIds.length > 0) {
        try {
          const firstToken = await this.refreshIfNeeded(connections[0])
          const { data: batchItems } = await axios.get(`${ML_BASE}/items`, {
            headers: { Authorization: `Bearer ${firstToken}` },
            params: {
              ids: itemIds.slice(0, 20).join(','),
              attributes: 'id,thumbnail',
            },
          })
          ;(Array.isArray(batchItems) ? batchItems : [])
            .filter((r: any) => r.code === 200)
            .forEach((r: any) => {
              if (r.body?.id) thumbMap[r.body.id] = r.body.thumbnail ?? ''
            })
        } catch { /* non-fatal */ }
      }
    }

    // Aggregate accumulators
    let faturamento_ml = 0, canceladas = 0
    let tarifa_total = 0, frete_vendedor_total = 0, frete_comprador_total = 0
    let custo_total = 0, imposto_total = 0
    let qtd_aprovadas = 0, qtd_canceladas = 0

    const enrichedOrders = allOrders.map((o: any) => {
      const ship = shipMap[o.shipping?.id] ?? null
      const totalAmount: number = o.total_amount ?? 0
      const isCancelled = o.status === 'cancelled'
      const tarifaML = Math.round(totalAmount * 0.115 * 100) / 100
      const freteVendedor: number = ship
        ? (ship.cost_components?.receiver_shipping_cost ?? ship.base_cost ?? 0)
        : 0
      const freteComprador: number =
        ship?.cost_components?.buyer_shipping_cost ?? 0
      const lucroBruto =
        Math.round((totalAmount - tarifaML - freteVendedor) * 100) / 100

      const firstItem = o.order_items?.[0]
      const firstSku = firstItem?.item?.seller_sku ?? null
      const prodData = firstSku ? (productMap[firstSku] ?? null) : null
      const costPrice: number | null = prodData?.cost_price ?? null
      const taxPct: number | null = prodData?.tax_percentage ?? null
      const taxOnFreight: boolean = prodData?.tax_on_freight ?? false

      let taxAmount: number | null = null
      let contribMargin: number | null = null
      let contribMarginPct: number | null = null

      if (taxPct != null) {
        const taxBase = taxOnFreight
          ? totalAmount + freteVendedor
          : totalAmount
        taxAmount = Math.round(taxBase * (taxPct / 100) * 100) / 100
      }
      if (costPrice != null || taxAmount != null) {
        const cm = lucroBruto - (costPrice ?? 0) - (taxAmount ?? 0)
        contribMargin = Math.round(cm * 100) / 100
        contribMarginPct =
          totalAmount > 0
            ? Math.round((cm / totalAmount) * 10000) / 100
            : 0
      }

      if (!isCancelled) {
        faturamento_ml += totalAmount
        tarifa_total += tarifaML
        frete_vendedor_total += freteVendedor
        frete_comprador_total += freteComprador
        custo_total += costPrice ?? 0
        imposto_total += taxAmount ?? 0
        qtd_aprovadas++
      } else {
        canceladas += totalAmount
        qtd_canceladas++
      }

      return {
        order_id: o.id,
        status: o.status,
        date_created: o.date_created,
        account_nickname: o._account_nickname,
        seller_id: o._seller_id,
        item_id: firstItem?.item?.id ?? null,
        title: firstItem?.item?.title ?? null,
        sku: firstSku,
        thumbnail: thumbMap[firstItem?.item?.id ?? ''] ?? null,
        quantity: firstItem?.quantity ?? 1,
        unit_price: firstItem?.unit_price ?? totalAmount,
        total_amount: totalAmount,
        shipping_type: ship?.logistic_type ?? o.shipping?.mode ?? null,
        frete_comprador: freteComprador,
        frete_vendedor: freteVendedor,
        tarifa_ml: tarifaML,
        cost_price: costPrice,
        tax_amount: taxAmount,
        lucro_bruto: lucroBruto,
        contribution_margin: contribMargin,
        contribution_margin_pct: contribMarginPct,
        is_paid: !isCancelled,
        is_cancelled: isCancelled,
      }
    })

    const vendas_aprovadas =
      faturamento_ml - tarifa_total - frete_vendedor_total
    const margem_contribuicao =
      vendas_aprovadas - custo_total - imposto_total
    const margem_pct =
      faturamento_ml > 0
        ? Math.round((margem_contribuicao / faturamento_ml) * 10000) / 100
        : 0
    const ticket_medio =
      qtd_aprovadas > 0
        ? Math.round((faturamento_ml / qtd_aprovadas) * 100) / 100
        : 0
    const ticket_medio_mc =
      qtd_aprovadas > 0
        ? Math.round((margem_contribuicao / qtd_aprovadas) * 100) / 100
        : 0

    const r = (v: number) => Math.round(v * 100) / 100
    const kpis = {
      vendas_aprovadas:   r(vendas_aprovadas),
      faturamento_ml:     r(faturamento_ml),
      canceladas:         r(canceladas),
      custo_total:        r(custo_total),
      imposto_total:      r(imposto_total),
      tarifa_total:       r(tarifa_total),
      frete_comprador:    r(frete_comprador_total),
      frete_vendedor:     r(frete_vendedor_total),
      frete_total:        r(frete_vendedor_total + frete_comprador_total),
      margem_contribuicao: r(margem_contribuicao),
      margem_pct,
      qtd_aprovadas,
      qtd_canceladas,
      ticket_medio,
      ticket_medio_mc,
    }

    const donutBase = faturamento_ml || 1
    const donutData = [
      { name: 'Custo',          value: r(custo_total),          pct: r((custo_total / donutBase) * 100),          color: '#f97316' },
      { name: 'Tarifa',         value: r(tarifa_total),         pct: r((tarifa_total / donutBase) * 100),         color: '#f59e0b' },
      { name: 'Frete',          value: r(frete_vendedor_total), pct: r((frete_vendedor_total / donutBase) * 100), color: '#3b82f6' },
      { name: 'Imposto',        value: r(imposto_total),        pct: r((imposto_total / donutBase) * 100),        color: '#ef4444' },
      { name: 'M. Contribuição',value: r(margem_contribuicao),  pct: margem_pct,                                  color: '#22c55e' },
    ]

    return {
      kpis,
      donut_data: donutData,
      orders: kpisOnly ? [] : enrichedOrders,
    }
  }

  // ── Create products from listings ─────────────────────────────────────────

  async createFromListing(orgId: string | null, listingIds: string[]) {
    const { token, sellerId: tokenSellerId } = await this.getValidToken()

    let resolvedOrgId = orgId
    if (!resolvedOrgId) {
      const { data: conn } = await supabaseAdmin
        .from('ml_connections')
        .select('organization_id')
        .eq('seller_id', tokenSellerId)
        .maybeSingle()
      resolvedOrgId = conn?.organization_id ?? null
    }
    // resolvedOrgId may still be null — products table accepts null organization_id

    // Fetch item details + descriptions in parallel
    const [itemsRes, descRes] = await Promise.all([
      Promise.allSettled(
        listingIds.map(id =>
          axios.get(`${ML_BASE}/items/${id}`, {
            headers: { Authorization: `Bearer ${token}` },
            params: {
              attributes: [
                'id','title','price','available_quantity','sold_quantity',
                'thumbnail','pictures','seller_custom_field','category_id',
                'listing_type_id','shipping','attributes','catalog_product_id',
                'permalink','condition',
              ].join(','),
            },
          }),
        ),
      ),
      Promise.allSettled(
        listingIds.map(id =>
          axios.get(`${ML_BASE}/items/${id}/description`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ),
      ),
    ])

    const results: Array<{
      listing_id: string
      status: 'created' | 'skipped' | 'error'
      product_id?: string
      reason?: string
    }> = []

    for (let i = 0; i < listingIds.length; i++) {
      const mlId = listingIds[i]

      if (itemsRes[i].status === 'rejected') {
        const reason = (itemsRes[i] as PromiseRejectedResult).reason?.response?.data?.message ?? 'Falha ao buscar anúncio no ML'
        results.push({ listing_id: mlId, status: 'error', reason })
        continue
      }

      const item = (itemsRes[i] as PromiseFulfilledResult<any>).value.data
      const desc =
        descRes[i].status === 'fulfilled'
          ? ((descRes[i] as PromiseFulfilledResult<any>).value.data?.plain_text ?? null)
          : null

      // seller_custom_field is the canonical SKU; fall back to SELLER_SKU attribute
      const sku: string | null =
        item.seller_custom_field ||
        (item.attributes ?? []).find((a: any) => a.id === 'SELLER_SKU')?.value_name ||
        null

      // Check for duplicate by ml_listing_id (works regardless of SKU presence)
      const { data: existingByListing } = await supabaseAdmin
        .from('products')
        .select('id')
        .eq('ml_listing_id', item.id)
        .maybeSingle()

      if (existingByListing) {
        results.push({ listing_id: mlId, status: 'skipped', reason: 'Anúncio já importado' })
        continue
      }

      // Also check duplicate by SKU when present
      if (sku) {
        const dupQuery = supabaseAdmin.from('products').select('id').eq('sku', sku)
        const { data: existingBySku } = await (
          resolvedOrgId
            ? dupQuery.eq('organization_id', resolvedOrgId)
            : dupQuery.is('organization_id', null)
        ).maybeSingle()
        if (existingBySku) {
          results.push({ listing_id: mlId, status: 'skipped', reason: 'SKU já existe' })
          continue
        }
      }

      // ── Extract ML attributes ──────────────────────────────────────
      const attrs: any[] = item.attributes ?? []

      // ML attribute value is at attribute.value_name (top-level) or values[0].name
      const attrStr = (id: string): string | null => {
        const a = attrs.find((a: any) => a.id === id)
        return a?.value_name ?? a?.values?.[0]?.name ?? null
      }

      const attrNum = (id: string, toUnit: string): number | null => {
        const s = attrs.find((a: any) => a.id === id)?.values?.[0]?.struct
        if (!s) return null
        if (s.unit === toUnit) return s.number
        if (toUnit === 'kg' && s.unit === 'g')  return s.number / 1000
        if (toUnit === 'g'  && s.unit === 'kg') return s.number * 1000
        if (toUnit === 'cm' && s.unit === 'mm') return s.number / 10
        if (toUnit === 'mm' && s.unit === 'cm') return s.number * 10
        return s.number
      }

      const weightKg = attrNum('WEIGHT', 'kg')
      const widthCm  = attrNum('WIDTH',  'cm')
      const heightCm = attrNum('HEIGHT', 'cm')
      const lengthCm = attrNum('LENGTH', 'cm') ?? attrNum('DEPTH', 'cm')
      const brand    = attrStr('BRAND')
      const model    = attrStr('MODEL')
      const gtin     = attrStr('GTIN') ?? attrStr('EAN') ?? item.ean ?? null
      const color    = attrStr('COLOR')
      const voltage  = attrStr('VOLTAGE')

      // Power: try value_name first ("40W"), then construct from struct
      const powerStr = attrStr('POWER')
      const powerStruct = attrs.find((a: any) => a.id === 'POWER')?.values?.[0]?.struct
      const power = powerStr ?? (powerStruct ? `${powerStruct.number}${powerStruct.unit ?? 'W'}` : null)

      const material        = attrStr('MAIN_MATERIAL')
      const originCountry   = attrStr('ORIGIN') ?? attrStr('ITEM_ORIGIN')
      const lightingType    = attrStr('LIGHTING_TYPE')
      const lampType        = attrStr('BULB_TYPE') ?? attrStr('LAMP_TYPE')
      const connectionType  = attrStr('CONNECTION_TYPE')
      const installLocation = attrStr('INSTALLATION_PLACE') ?? attrStr('INSTALL_LOCATION')

      const mlFlex = item.shipping?.logistic_type === 'fulfillment'

      const photoUrls: string[] = (item.pictures ?? [])
        .map((p: any) => p.url ?? p.secure_url)
        .filter(Boolean)

      const mlListingType = (() => {
        const t = item.listing_type_id ?? ''
        if (t.includes('premium') || t.includes('gold_pro')) return 'premium'
        return 'classic'
      })()

      const payload = {
        organization_id:  resolvedOrgId,
        name:             item.title,
        sku,
        brand,
        model,
        gtin,
        ml_title:         item.title,
        price:            item.price ?? 0,
        stock:            item.available_quantity ?? 0,
        status:           'active',
        condition:        item.condition === 'new' ? 'new' : 'used',
        category:         item.category_id ?? null,
        description:      desc,
        photo_urls:       photoUrls.length > 0 ? photoUrls : null,
        ml_listing_id:    item.id,
        ml_listing_type:  mlListingType,
        ml_permalink:     item.permalink ?? null,
        ml_catalog_id:    item.catalog_product_id ?? null,
        ml_free_shipping: item.shipping?.free_shipping ?? false,
        ml_flex:          mlFlex,
        platforms:        ['mercadolivre'],
        weight_kg:        weightKg,
        width_cm:         widthCm,
        height_cm:        heightCm,
        length_cm:        lengthCm,
        attributes: {
          ...(color          ? { color }                           : {}),
          ...(voltage        ? { voltage }                         : {}),
          ...(power          ? { power }                           : {}),
          ...(material       ? { material }                        : {}),
          ...(originCountry  ? { origin_country: originCountry }   : {}),
          ...(lightingType   ? { lighting_type: lightingType }     : {}),
          ...(lampType       ? { lamp_type: lampType }             : {}),
          ...(connectionType ? { connection_type: connectionType } : {}),
          ...(installLocation? { install_location: installLocation }: {}),
          warranty_type: 'seller',
          warranty_days: 90,
        },
        created_at:       new Date().toISOString(),
      }

      const { data: created, error } = await supabaseAdmin
        .from('products')
        .insert(payload)
        .select()
        .single()

      if (error) {
        console.error('[from-listing] INSERT failed:', error.code, error.message)
        results.push({ listing_id: mlId, status: 'error', reason: error.message })
      } else {
        // Manter vínculo na nova tabela product_listings (fase 1 de refatoração)
        const { error: plError } = await supabaseAdmin
          .from('product_listings')
          .insert({
            product_id:        created.id,
            platform:          'mercadolivre',
            listing_id:        item.id,
            listing_title:     item.title ?? null,
            listing_price:     item.price ?? null,
            listing_thumbnail: item.pictures?.[0]?.url ?? item.pictures?.[0]?.secure_url ?? null,
            listing_permalink: item.permalink ?? null,
            quantity_per_unit: 1,
            is_active:         true,
          })
        if (plError) console.warn('[from-listing] product_listings insert falhou (não crítico):', plError.message)

        // Estoque compartilhado inicial (platform/account nulos = estoque global)
        const { error: psError } = await supabaseAdmin
          .from('product_stock')
          .insert({
            product_id:       created.id,
            platform:         null,
            account_id:       null,
            quantity:         item.available_quantity ?? 0,
            reserved_quantity: 0,
          })
        if (psError) console.warn('[from-listing] product_stock insert falhou (não crítico):', psError.message)

        results.push({ listing_id: mlId, status: 'created', product_id: created.id })
      }
    }

    return { results }
  }
}
