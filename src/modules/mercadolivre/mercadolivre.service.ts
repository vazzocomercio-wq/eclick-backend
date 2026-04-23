import { Injectable, UnauthorizedException, HttpException, BadRequestException, NotFoundException } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'

const ML_BASE = 'https://api.mercadolibre.com'
const ML_AUTH = 'https://auth.mercadolibre.com.br'

export interface MlTokens {
  access_token: string
  refresh_token: string
  expires_at: number // unix ms
  seller_id: number
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

    // Delete existing row for this seller then insert fresh (avoids onConflict constraint dependency)
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

  async disconnect(orgId: string): Promise<void> {
    await supabaseAdmin.from('ml_connections').delete().eq('organization_id', orgId)
  }

  async getConnection(orgId: string) {
    console.log('[ML status] looking up orgId:', orgId)

    const { data, error } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id, expires_at, access_token, nickname, organization_id')
      .eq('organization_id', orgId)
      .maybeSingle()

    console.log('[ML status] result by orgId:', data, 'error:', error?.message)

    if (data) return data

    // Fallback: return first available connection (temporary diagnostic)
    const { data: fallback } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id, expires_at, access_token, nickname, organization_id')
      .limit(1)
      .maybeSingle()

    console.log('[ML status] fallback result:', fallback)
    return fallback
  }

  // ── Item info (for competitor lookup) ────────────────────────────────────

  async getItemInfo(_orgId: string, url: string) {
    // Only purely numeric MLB IDs work with /items/ endpoint.
    // MLBU... (catalog IDs) and friendly URLs must go through search.
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

    // ── Catalog ID (MLBU…) or friendly URL → search by slug ─────────────────
    // Extract the product-name path segment (contains hyphens, not an ID)
    let query: string
    try {
      const { pathname } = new URL(url)
      const segments = pathname.split('/').filter((s: string) => s.length > 3 && !s.startsWith('_') && s !== 'p')
      // Prefer segment with hyphens (product name) over bare IDs
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

  // ── Auth helper: busca conexão ML, faz refresh se expirado ─────────────────

  private async getValidToken(): Promise<{ token: string; sellerId: number }> {
    const { data: conn, error } = await supabaseAdmin
      .from('ml_connections')
      .select('access_token, refresh_token, expires_at, seller_id')
      .limit(1)
      .single()

    if (error || !conn) {
      console.error('[getValidToken] sem conexão ML no banco:', error?.message)
      throw new UnauthorizedException('ML não conectado')
    }

    const expiresAt = new Date(conn.expires_at)
    const now = new Date()
    const isExpired = expiresAt.getTime() - now.getTime() < 5 * 60 * 1000

    console.log('[getValidToken] seller_id:', conn.seller_id, '| expires_at:', conn.expires_at, '| expirado:', isExpired)

    if (!isExpired) {
      return { token: conn.access_token, sellerId: conn.seller_id }
    }

    // Token expirado — fazer refresh
    console.log('[getValidToken] iniciando refresh para seller:', conn.seller_id)
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
      console.log('[getValidToken] refresh ok — novo expires_at:', newExpiresAt)

      await supabaseAdmin
        .from('ml_connections')
        .update({ access_token, refresh_token, expires_at: newExpiresAt })
        .eq('seller_id', conn.seller_id)

      return { token: access_token, sellerId: conn.seller_id }
    } catch (refreshErr: any) {
      const status = refreshErr?.response?.status ?? 'sem status'
      const body   = JSON.stringify(refreshErr?.response?.data ?? refreshErr?.message)
      console.error('[getValidToken] refresh FALHOU — status:', status, '| body:', body)
      throw new HttpException(`Token ML expirado e refresh falhou (${status})`, 401)
    }
  }

  // ── Pipeline endpoints ───────────────────────────────────────────────────

  // 1. GET /ml/my-items — active listing IDs
  async getMyItems(orgId: string) {
    const { token, sellerId } = await this.getValidToken()
    const { data: body } = await axios.get(`${ML_BASE}/users/${sellerId}/items/search`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { status: 'active', limit: 50 },
    })
    return { items: body.results ?? [], total: body.paging?.total ?? 0 }
  }

  // 2. GET /ml/items/:mlbId — item detail
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

  // 3. GET /ml/items/:mlbId/visits — 7-day visits
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

  // 4. GET /ml/recent-orders — orders with item detail
  async getRecentOrders(orgId: string, offset = 0, limit = 50) {
    let token: string
    let sellerId: number
    try {
      ;({ token, sellerId } = await this.getValidToken())
    } catch (authErr: any) {
      console.error('[recent-orders] getValidToken failed:', authErr?.message ?? authErr)
      throw new HttpException('ML não conectado — verifique a integração', 401)
    }

    // Cap limit at 50 (ML API rejects higher values on some accounts)
    const safeLimit = Math.min(limit, 50)
    console.log('[recent-orders] sellerId:', sellerId, 'limit:', safeLimit)

    try {
      const { data: body } = await axios.get(`${ML_BASE}/orders/search`, {
        headers: { Authorization: `Bearer ${token}` },
        // offset omitted — some seller profiles return 400 when offset=0 is explicit
        params: { seller: sellerId, sort: 'date_desc', limit: safeLimit },
      })

      console.log('[recent-orders] ML status OK, total:', body.paging?.total)

      return {
        orders: (body.results ?? []).map((o: any) => ({
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
        })),
        total: body.paging?.total ?? 0,
      }
    } catch (err: any) {
      const mlStatus = err?.response?.status ?? 500
      const mlData   = err?.response?.data
      console.error('[recent-orders] ML error status:', mlStatus)
      console.error('[recent-orders] ML error body:', JSON.stringify(mlData))

      // 400 from ML usually means param issue — return empty rather than crashing the dashboard
      if (mlStatus === 400) {
        console.warn('[recent-orders] 400 received — trying fallback without sort param')
        try {
          const { data: body2 } = await axios.get(`${ML_BASE}/orders/search`, {
            headers: { Authorization: `Bearer ${token}` },
            params: { seller: sellerId, limit: safeLimit },
          })
          console.log('[recent-orders] fallback OK, total:', body2.paging?.total)
          return {
            orders: (body2.results ?? []).map((o: any) => ({
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
            })),
            total: body2.paging?.total ?? 0,
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

  // 5. GET /ml/catalog-competitors/:catalogId
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

  // 6. GET /ml/seller-info
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

  // 7. GET /ml/reputation
  async getReputation(orgId: string) {
    let sellerId: number
    let token: string
    try {
      ;({ sellerId, token } = await this.getValidToken())
    } catch (authErr: any) {
      console.error('[reputation] getValidToken failed:', authErr?.message)
      throw new HttpException('ML não conectado', 401)
    }

    console.log('[reputation] seller_id:', sellerId)

    // Tentativa 1: /users/me/seller_reputation com token
    try {
      const url1 = `${ML_BASE}/users/me/seller_reputation`
      console.log('[reputation] chamando URL:', url1)
      const { data } = await axios.get(url1, { headers: { Authorization: `Bearer ${token}` } })
      console.log('[reputation] /me ok:', JSON.stringify(data)?.substring(0, 200))
      return { seller_id: sellerId, ...data }
    } catch (err1: any) {
      console.warn('[reputation] /me falhou:', err1?.response?.status, err1?.response?.data?.message ?? err1?.message)
    }

    // Tentativa 2: /users/{sellerId} com token — extrai seller_reputation
    try {
      const url2 = `${ML_BASE}/users/${sellerId}`
      console.log('[reputation] chamando URL:', url2)
      const publicResponse = await axios.get(url2, { headers: { Authorization: `Bearer ${token}` } })
      console.log('[reputation] full response keys:', Object.keys(publicResponse.data || {}))
      console.log('[reputation] seller_reputation:', JSON.stringify(publicResponse.data?.seller_reputation))
      const rep = publicResponse.data?.seller_reputation ?? null
      return { seller_id: sellerId, ...(rep ?? {}) }
    } catch (err2: any) {
      console.error('[reputation] /users/{id} falhou:', err2?.response?.status, err2?.response?.data?.message ?? err2?.message)
    }

    // Fallback: estrutura vazia para não quebrar a página
    console.error('[reputation] todas as tentativas falharam — retornando fallback')
    return {
      seller_id: sellerId,
      level_id: null,
      power_seller_status: null,
      transactions: {
        canceled:  { total: 0, paid: 0 },
        completed: { total: 0, paid: 0 },
        total: 0,
        ratings: { negative: 0, neutral: 0, positive: 0 },
        period: { total: 0, paid: 0 },
      },
      metrics: {
        sales:                { period: 'past 60 days', completed: 0 },
        claims:               { period: 'past 60 days', rate: 0, value: 0 },
        mediation:            { period: 'past 60 days', rate: 0, value: 0 },
        cancellations:        { period: 'past 60 days', rate: 0, value: 0 },
        delayed_handling_time:{ period: 'past 60 days', rate: 0, value: 0 },
      },
    }
  }

  // 8. GET /ml/questions — unanswered
  async getQuestions(orgId: string) {
    try {
      const { token } = await this.getValidToken()
      const { data: body } = await axios.get(`${ML_BASE}/my/received_questions`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { status: 'unanswered' },
      })
      return { questions: body.questions ?? [], total: body.total ?? 0 }
    } catch (err: any) {
      const status = err?.response?.status ?? 500
      console.error('[questions] ML error:', status, err?.response?.data?.message ?? err?.message)
      // 403/404 → scope not granted or endpoint unavailable — return empty
      if (status === 403 || status === 404 || status === 401) return { questions: [], total: 0 }
      throw new HttpException(err?.response?.data?.message ?? err?.message ?? 'Erro ao buscar perguntas', status)
    }
  }

  // 8. GET /ml/claims — open claims (role=seller: we are the respondent)
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
      // 403/404 → scope not granted or endpoint unavailable — return empty
      if (status === 403 || status === 404 || status === 401) return { data: [], total: 0 }
      throw new HttpException(err?.response?.data?.message ?? err?.message ?? 'Erro ao buscar reclamações', status)
    }
  }
}
