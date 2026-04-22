import { Injectable, UnauthorizedException, HttpException } from '@nestjs/common'
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
    const { data } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id, expires_at, access_token, nickname')
      .eq('organization_id', orgId)
      .maybeSingle()
    return data
  }

  // ── Token management ─────────────────────────────────────────────────────

  async getValidToken(orgId: string): Promise<string> {
    const { data: conn, error } = await supabaseAdmin
      .from('ml_connections')
      .select('access_token, refresh_token, expires_at')
      .eq('organization_id', orgId)
      .maybeSingle()

    if (error || !conn) throw new UnauthorizedException('ML not connected')

    const expiresAt = new Date(conn.expires_at).getTime()
    if (Date.now() < expiresAt - 60_000) return conn.access_token

    // Refresh
    const res = await axios.post<{
      access_token: string
      refresh_token: string
      expires_in: number
    }>(
      `${ML_BASE}/oauth/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.ML_CLIENT_ID!,
        client_secret: process.env.ML_CLIENT_SECRET!,
        refresh_token: conn.refresh_token,
      }),
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    )

    const { access_token, refresh_token, expires_in } = res.data
    const new_expires_at = new Date(Date.now() + expires_in * 1000).toISOString()

    await supabaseAdmin
      .from('ml_connections')
      .update({ access_token, refresh_token, expires_at: new_expires_at })
      .eq('organization_id', orgId)

    return access_token
  }

  // ── Items ────────────────────────────────────────────────────────────────

  async getItems(orgId: string, offset = 0, limit = 50) {
    const token = await this.getValidToken(orgId)
    const { data: conn } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id')
      .eq('organization_id', orgId)
      .maybeSingle()

    if (!conn) throw new UnauthorizedException('ML not connected')

    const { data: search } = await axios.get(
      `${ML_BASE}/users/${conn.seller_id}/items/search`,
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
    const token = await this.getValidToken(orgId)

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
    const token = await this.getValidToken(orgId)
    const { data: conn } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id')
      .eq('organization_id', orgId)
      .maybeSingle()

    if (!conn) throw new UnauthorizedException('ML not connected')

    const { data } = await axios.get(
      `${ML_BASE}/orders/search`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { seller: conn.seller_id, offset, limit, sort: 'date_desc' },
      },
    )

    return { orders: data.data.results ?? [], total: data.data.paging?.total ?? 0 }
  }

  // ── Metrics ──────────────────────────────────────────────────────────────

  async getMetrics(orgId: string) {
    const token = await this.getValidToken(orgId)
    const { data: conn } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id')
      .eq('organization_id', orgId)
      .maybeSingle()

    if (!conn) throw new UnauthorizedException('ML not connected')

    const [visits, sales] = await Promise.all([
      axios.get(`${ML_BASE}/users/${conn.seller_id}/items_visits`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { date_from: this.daysAgo(30), date_to: this.today() },
      }),
      axios.get(`${ML_BASE}/orders/search`, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          seller: conn.seller_id,
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
}
