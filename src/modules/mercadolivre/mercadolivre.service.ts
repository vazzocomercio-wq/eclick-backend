import { Injectable, UnauthorizedException, HttpException, BadRequestException, NotFoundException } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'

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
    console.log('[ML connect] orgId:', orgId)
    console.log('[ML connect] redirectUri:', redirectUri)
    console.log('[ML connect] code length:', code?.length)
    console.log('[ML connect] ML_CLIENT_ID:', process.env.ML_CLIENT_ID?.substring(0, 8))
    console.log('[ML connect] ML_CLIENT_SECRET length:', process.env.ML_CLIENT_SECRET?.length)

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
    console.log('[ML connect] token exchange ok, user_id:', user_id)

    let nickname = `Conta #${user_id}`
    await axios.get<{ nickname?: string; first_name?: string }>(
      `${ML_BASE}/users/me`,
      { headers: { Authorization: `Bearer ${access_token}` } },
    ).then((r) => {
      nickname = r.data.nickname ?? r.data.first_name ?? nickname
      console.log('[ML connect] nickname:', nickname)
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
    console.log('[ML status] looking up orgId:', orgId)

    const { data, error } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id, expires_at, access_token, nickname, organization_id')
      .eq('organization_id', orgId)
      .maybeSingle()

    console.log('[ML status] result by orgId:', data, 'error:', error?.message)

    if (data) return data

    const { data: fallback } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id, expires_at, access_token, nickname, organization_id')
      .limit(1)
      .maybeSingle()

    console.log('[ML status] fallback result:', fallback)
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

    console.log('[refreshIfNeeded] iniciando refresh para seller:', conn.seller_id)
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
      console.log('[refreshIfNeeded] refresh ok — seller:', conn.seller_id, 'novo expires_at:', newExpiresAt)

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

  private async getValidToken(): Promise<{ token: string; sellerId: number }> {
    const connections = await this.getAllConnections()
    if (!connections.length) {
      console.error('[getValidToken] sem conexão ML no banco')
      throw new UnauthorizedException('ML não conectado')
    }
    const conn = connections[0]
    console.log('[getValidToken] seller_id:', conn.seller_id, '| expires_at:', conn.expires_at)
    const token = await this.refreshIfNeeded(conn)
    return { token, sellerId: conn.seller_id }
  }

  // ── Item info (for competitor lookup) ────────────────────────────────────

  async getItemInfo(_orgId: string, url: string) {
    const numericMatch = url.match(/MLB-?(\d{7,})\b/i)

    if (numericMatch) {
      const mlbId = `MLB${numericMatch[1]}`

      const { data: item } = await axios.get(`${ML_BASE}/items/${mlbId}`)
        .catch((err: any) => {
          throw new HttpException(
            err.response?.data?.message ?? `ML retornou ${err.response?.status ?? 500}`,
            err.response?.status ?? 500,
          )
        })

      let seller = `Vendedor #${item.data.seller_id}`
      await axios.get(`${ML_BASE}/users/${item.data.seller_id}`)
        .then((r: any) => { if (r.data.nickname) seller = r.data.nickname })
        .catch(() => { /* non-fatal */ })

      return {
        title: item.data.title ?? null,
        price: item.data.price ?? null,
        seller,
        thumbnail: item.data.thumbnail ?? null,
        mlbId,
        permalink: item.data.permalink ?? null,
      }
    }

    let query: string
    try {
      const { pathname } = new URL(url)
      const segments = pathname.split('/').filter((s: string) => s.length > 3 && !s.startsWith('_') && s !== 'p')
      const slug = segments.find((s: string) => s.includes('-') && !/^MLB/i.test(s)) ?? segments[0]
      if (!slug) throw new Error()
      query = slug.replace(/-/g, ' ').trim()
    } catch {
      throw new BadRequestException('Não foi possível extrair o produto desta URL.')
    }

    const { data: search } = await axios.get(`${ML_BASE}/sites/MLB/search`, {
      params: { q: query, limit: 3 },
    }).catch((err: any) => {
      throw new HttpException(
        err.response?.data?.message ?? `ML Search retornou ${err.response?.status ?? 500}`,
        err.response?.status ?? 500,
      )
    })

    const result = search.data.results?.[0]
    if (!result) throw new NotFoundException('Nenhum produto encontrado para esta URL.')

    return {
      title: result.title ?? null,
      price: result.price ?? null,
      seller: result.seller?.nickname ?? null,
      thumbnail: result.thumbnail ?? null,
      mlbId: result.id ?? null,
      permalink: result.permalink ?? null,
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
    if (!ids.length) {
      console.log('[shipments] no shipping ids found in orders')
      return map
    }
    console.log('[shipments] fetching', ids.length, 'shipments:', ids.slice(0, 5).join(','), '...')
    const results = await Promise.allSettled(
      ids.map(id => axios.get(`${ML_BASE}/shipments/${id}`, { headers: { Authorization: `Bearer ${token}` } }))
    )
    ids.forEach((id, i) => {
      if (results[i].status === 'fulfilled') {
        map[id] = (results[i] as PromiseFulfilledResult<any>).value.data
      } else {
        console.warn('[shipments] failed for id', id, ':', (results[i] as PromiseRejectedResult).reason?.response?.status)
      }
    })
    const withAddress = Object.values(map).filter(s => s?.receiver_address?.state?.id).length
    console.log('[shipments] fetched', Object.keys(map).length, '| with receiver_address+state:', withAddress)
    return map
  }

  private _mapOrder(o: any, shipMap: Record<number, any>) {
    const ship = shipMap[o.shipping?.id] ?? null
    const stateId: string = ship?.receiver_address?.state?.id ?? ''
    // ML returns "BR-SP" — extract "SP"
    const uf = stateId.startsWith('BR-') ? stateId.slice(3) : (stateId.length === 2 ? stateId : null)
    console.log(`[mapOrder] order ${o.id} | shipping_id=${o.shipping?.id} | stateId="${stateId}" | uf=${uf} | city=${ship?.receiver_address?.city?.name}`)
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

      console.log(`[recent-orders] page offset=${pageOffset} total=${total ?? '?'}`)

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

    console.log(`[recent-orders] total coletado: ${allOrders.length} / ${total ?? 0}`)
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

    console.log('[recent-orders] sellerId:', sellerId, 'dateFrom:', dateFrom ?? 'none', 'dateTo:', dateTo ?? 'none')

    try {
      const { results: rawOrders, total } = await this._fetchAllOrders(token, sellerId, dateFrom, dateTo, true)
      const shipMap = await this._fetchShipments(token, rawOrders)
      return {
        orders: rawOrders.map((o: any) => this._mapOrder(o, shipMap)),
        total,
      }
    } catch (err: any) {
      const mlStatus = err?.response?.status ?? 500
      const mlData   = err?.response?.data
      console.error('[recent-orders] ML error status:', mlStatus)
      console.error('[recent-orders] ML error body:', JSON.stringify(mlData))

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
      console.log('[reputation] metrics raw:', JSON.stringify(rep?.metrics))
      console.log('[reputation] transactions raw:', JSON.stringify(rep?.transactions))
      return rep || {}
    } catch (error: any) {
      console.error('[reputation] erro:', error?.response?.status, error?.message)
      return {}
    }
  }

  async getQuestions(orgId: string) {
    try {
      const { token } = await this.getValidToken()
      const { data: body } = await axios.get(`${ML_BASE}/my/received_questions`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { status: 'unanswered', limit: 50 },
      })
      const questions: any[] = body.questions ?? []

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

      return { questions: enriched, total: body.total ?? questions.length }
    } catch (err: any) {
      const status = err?.response?.status ?? 500
      console.error('[questions] ML error:', status, err?.response?.data?.message ?? err?.message)
      if (status === 403 || status === 404 || status === 401) return { questions: [], total: 0 }
      throw new HttpException(err?.response?.data?.message ?? err?.message ?? 'Erro ao buscar perguntas', status)
    }
  }

  async answerQuestion(orgId: string, questionId: number, text: string) {
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
      console.error('[answer-question] ML error:', status, err?.response?.data?.message ?? err?.message)
      throw new HttpException(err?.response?.data?.message ?? err?.message ?? 'Erro ao responder pergunta', status)
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
      console.error('[claims] ML error:', status, err?.response?.data?.message ?? err?.message)
      if (status === 403 || status === 404 || status === 401) return { data: [], total: 0 }
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
          'category_id', 'deal_ids', 'promotions', 'health',
          'catalog_listing_type_id',
        ].join(','),
      },
    })

    const baseItems = (Array.isArray(multi) ? multi : [])
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
          sku: i.attributes?.find((a: any) => a.id === 'SELLER_SKU')?.value_name ?? null,
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

    const healthResults = await Promise.allSettled(
      baseItems.map(item => axios.get(`${ML_BASE}/items/${item.id}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      }))
    )

    const items = baseItems.map((item, idx) => {
      const h = healthResults[idx]
      if (h.status === 'fulfilled') {
        const d = h.value.data
        return {
          ...item,
          health_score:   d?.overall_score  ?? null,
          health_status:  d?.status         ?? null,
          health_reasons: d?.reasons?.map((r: any) => r.message ?? r.id ?? String(r)) ?? [],
        }
      }
      return item
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

    // ── Shipping details in parallel ──────────────────────────────────────
    const shipIds = [...new Set(orders.map((o: any) => o.shipping?.id).filter(Boolean))] as number[]
    const shipMap: Record<number, any> = {}
    if (shipIds.length > 0) {
      const shipRes = await Promise.allSettled(
        shipIds.map(id => axios.get(`${ML_BASE}/shipments/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        }))
      )
      shipIds.forEach((id, i) => {
        if (shipRes[i].status === 'fulfilled') shipMap[id] = (shipRes[i] as any).value.data
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

    const enriched = orders.map((o: any) => {
      const ship = shipMap[o.shipping?.id] ?? null
      const totalAmount: number = o.total_amount ?? 0
      const tarifaML     = Math.round(totalAmount * 0.115 * 100) / 100
      const freteVendedor: number = ship?.cost_components?.receiver_shipping_cost ?? ship?.base_cost ?? 0
      const lucroBruto   = Math.round((totalAmount - tarifaML - freteVendedor) * 100) / 100

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

    console.log('[fin-summary] inicio - dateFrom:', from, 'dateTo:', to)

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

      if (offset === 0) {
        paginationTotal = data?.paging?.total ?? 0
        console.log(`[fin-summary] total ML: ${paginationTotal} pedidos`)
      }

      for (const order of pageResults) {
        totalRevenue += order.total_amount ?? 0
        totalOrders++
      }

      offset += 50
      console.log(`[fin-summary] offset=${offset} | acumulado=${totalOrders}/${paginationTotal} | página=${pageResults.length}`)
    } while (pageResults.length === 50 && totalOrders < paginationTotal)

    console.log(`[fin-summary] FINAL: R$${totalRevenue.toFixed(2)} | ${totalOrders} pedidos (ML diz ${paginationTotal})`)

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

  async createFromListing(orgId: string, listingIds: string[]) {
    const { token } = await this.getValidToken()

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
        results.push({ listing_id: mlId, status: 'error', reason: 'Falha ao buscar anúncio no ML' })
        continue
      }

      const item = (itemsRes[i] as PromiseFulfilledResult<any>).value.data
      const desc =
        descRes[i].status === 'fulfilled'
          ? ((descRes[i] as PromiseFulfilledResult<any>).value.data?.plain_text ?? null)
          : null

      const sku: string = item.seller_custom_field || item.id

      // Check for duplicate SKU
      const { data: existing } = await supabaseAdmin
        .from('products')
        .select('id')
        .eq('organization_id', orgId)
        .eq('sku', sku)
        .maybeSingle()

      if (existing) {
        results.push({ listing_id: mlId, status: 'skipped', reason: 'SKU já existe' })
        continue
      }

      // Extract weight from ML attributes
      const attrs: Array<{ id: string; values?: Array<{ struct?: { number: number; unit: string } }> }> =
        item.attributes ?? []
      const weightAttr = attrs.find(a => a.id === 'WEIGHT')
      const wStruct    = weightAttr?.values?.[0]?.struct
      const weightKg   = wStruct
        ? wStruct.unit === 'kg' ? wStruct.number : wStruct.number / 1000
        : null

      const photoUrls: string[] = (item.pictures ?? [])
        .map((p: any) => p.url ?? p.secure_url)
        .filter(Boolean)

      const mlListingType = (() => {
        const t = item.listing_type_id ?? ''
        if (t.includes('premium') || t.includes('gold_pro')) return 'premium'
        return 'classic'
      })()

      const payload = {
        organization_id:  orgId,
        name:             item.title,
        sku,
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
        platforms:        ['mercadolivre'],
        weight_kg:        weightKg,
        created_at:       new Date().toISOString(),
      }

      const { data: created, error } = await supabaseAdmin
        .from('products')
        .insert(payload)
        .select('id')
        .single()

      if (error) {
        results.push({ listing_id: mlId, status: 'error', reason: error.message })
      } else {
        results.push({ listing_id: mlId, status: 'created', product_id: created.id })
      }
    }

    return { results }
  }
}
