import {
  Controller, Get, Post, Body, UseGuards, HttpCode, HttpStatus,
  BadRequestException, InternalServerErrorException, Logger,
} from '@nestjs/common'
import axios from 'axios'
import * as crypto from 'crypto'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { MarketplaceService } from './marketplace.service'

interface ReqUserPayload { id: string; orgId: string | null }

const SHOPEE_BASE = 'https://openplatform.shopee.com.br'
const MAGALU_API  = 'https://api.magalu.com'
const MAGALU_AUTH = 'https://id.magalu.com'
const MAGALU_SCOPES = [
  'open:order-order-seller:read',
  'open:order-delivery-seller:read',
  'open:order-invoice-seller:read',
].join(' ')

/** Endpoints OAuth pra Shopee/Magalu. Shopee usa HMAC-SHA256; Magalu usa
 * authorization_code padrão. Redirect URIs vêm de env (config do app no
 * portal de cada plataforma é lockada). */
@Controller('marketplace')
@UseGuards(SupabaseAuthGuard)
export class MarketplaceController {
  private readonly logger = new Logger(MarketplaceController.name)

  constructor(private readonly mp: MarketplaceService) {}

  // ── Shopee ──────────────────────────────────────────────────────────────

  /** Gera URL de autorização Shopee. Sign HMAC-SHA256 hex(partner_id +
   * api_path + timestamp, partner_key). Após login, Shopee redireciona pra
   * SHOPEE_REDIRECT_URI com `?code=...&shop_id=...`. */
  @Get('shopee/auth-url')
  shopeeAuthUrl() {
    const partnerId  = process.env.SHOPEE_PARTNER_ID
    const partnerKey = process.env.SHOPEE_PARTNER_KEY
    const redirect   = process.env.SHOPEE_REDIRECT_URI
    if (!partnerId || !partnerKey) throw new InternalServerErrorException('SHOPEE_PARTNER_ID/KEY não configurados')
    if (!redirect)                 throw new InternalServerErrorException('SHOPEE_REDIRECT_URI não configurado')

    const apiPath = '/api/v2/shop/auth_partner'
    const ts      = Math.floor(Date.now() / 1000)
    const sign    = crypto.createHmac('sha256', partnerKey)
      .update(`${partnerId}${apiPath}${ts}`).digest('hex')
    const url = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId,
      timestamp:  String(ts),
      sign,
      redirect,
    }).toString()
    return { url }
  }

  /** Callback Shopee. Body: { code, shop_id }. Troca por access/refresh
   * tokens via /api/v2/auth/token/get e persiste em marketplace_connections. */
  @Post('shopee/callback')
  @HttpCode(HttpStatus.OK)
  async shopeeCallback(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { code: string; shop_id: number | string },
  ) {
    if (!user.orgId)   throw new BadRequestException('orgId ausente')
    if (!body?.code)   throw new BadRequestException('code obrigatório')
    if (!body?.shop_id) throw new BadRequestException('shop_id obrigatório')

    const partnerId  = process.env.SHOPEE_PARTNER_ID
    const partnerKey = process.env.SHOPEE_PARTNER_KEY
    if (!partnerId || !partnerKey) throw new InternalServerErrorException('SHOPEE_PARTNER_ID/KEY não configurados')

    const shopId  = Number(body.shop_id)
    const apiPath = '/api/v2/auth/token/get'
    const ts      = Math.floor(Date.now() / 1000)
    const sign    = crypto.createHmac('sha256', partnerKey)
      .update(`${partnerId}${apiPath}${ts}`).digest('hex')
    const url = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId,
      timestamp:  String(ts),
      sign,
    }).toString()

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await axios.post<any>(url, {
        code:       body.code,
        partner_id: Number(partnerId),
        shop_id:    shopId,
      })
      if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)
      const ttlSec = Number(data?.expire_in ?? 14400)

      const conn = await this.mp.upsertConnection({
        organization_id: user.orgId,
        platform:        'shopee',
        shop_id:         shopId,
        access_token:    data.access_token,
        refresh_token:   data.refresh_token,
        expires_at:      new Date(Date.now() + ttlSec * 1000).toISOString(),
        nickname:        `Shopee #${shopId}`,
        status:          'connected',
      })
      return { ok: true, shop_id: shopId, nickname: conn.nickname }
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? 'erro'
      this.logger.error(`[shopee.callback] ${msg}`)
      throw new BadRequestException(`Falha ao trocar code por token: ${msg}`)
    }
  }

  // ── Magalu ──────────────────────────────────────────────────────────────

  /** Gera URL de autorização Magalu. Authorization Code padrão; redirect
   * ja é lockado no portal Magalu. */
  @Get('magalu/auth-url')
  magaluAuthUrl() {
    const clientId = process.env.MAGALU_CLIENT_ID
    const redirect = process.env.MAGALU_REDIRECT_URI
    if (!clientId) throw new InternalServerErrorException('MAGALU_CLIENT_ID não configurado')
    if (!redirect) throw new InternalServerErrorException('MAGALU_REDIRECT_URI não configurado')
    const url = `${MAGALU_AUTH}/login?` + new URLSearchParams({
      client_id:      clientId,
      redirect_uri:   redirect,
      scope:          MAGALU_SCOPES,
      response_type:  'code',
      choose_tenants: 'true',
    }).toString()
    return { url }
  }

  /** Callback Magalu. Body: { code }. Troca por tokens via
   * id.magalu.com/oauth/token e persiste. marketplace_id (X-Channel-Id)
   * fica null nesta etapa — o adapter throw quando faltar e o usuário
   * preenche manualmente em /integracoes ou via call extra a /portfolios
   * em sprint posterior. */
  @Post('magalu/callback')
  @HttpCode(HttpStatus.OK)
  async magaluCallback(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { code: string },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.code) throw new BadRequestException('code obrigatório')

    const clientId     = process.env.MAGALU_CLIENT_ID
    const clientSecret = process.env.MAGALU_CLIENT_SECRET
    const redirect     = process.env.MAGALU_REDIRECT_URI
    if (!clientId || !clientSecret) throw new InternalServerErrorException('MAGALU_CLIENT_ID/SECRET não configurados')
    if (!redirect)                  throw new InternalServerErrorException('MAGALU_REDIRECT_URI não configurado')

    try {
      const params = new URLSearchParams({
        grant_type:    'authorization_code',
        code:          body.code,
        redirect_uri:  redirect,
        client_id:     clientId,
        client_secret: clientSecret,
      })
      const { data } = await axios.post<{
        access_token: string; refresh_token: string; expires_in: number
      }>(`${MAGALU_AUTH}/oauth/token`, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })

      // Tenta descobrir o channel_id (mandatório pra X-Channel-Id) via
      // portfolios — best-effort; se falhar, salva null e usuário acerta depois.
      let channelId: string | null = null
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const port = await axios.get<any>(`${MAGALU_API}/seller/v1/portfolios`, {
          headers: { Authorization: `Bearer ${data.access_token}`, Accept: 'application/json' },
        })
        const first = port.data?.results?.[0] ?? port.data?.[0] ?? null
        channelId = first?.channel_id ?? first?.id ?? null
      } catch (err) {
        this.logger.warn(`[magalu.callback] portfolios fallback: ${(err as Error)?.message}`)
      }

      const conn = await this.mp.upsertConnection({
        organization_id: user.orgId,
        platform:        'magalu',
        marketplace_id:  channelId,
        access_token:    data.access_token,
        refresh_token:   data.refresh_token,
        expires_at:      new Date(Date.now() + data.expires_in * 1000).toISOString(),
        nickname:        channelId ? `Magalu (${channelId})` : 'Magalu',
        status:          'connected',
      })
      return { ok: true, channel_id: channelId, nickname: conn.nickname }
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? 'erro'
      this.logger.error(`[magalu.callback] ${msg}`)
      throw new BadRequestException(`Falha ao trocar code por token: ${msg}`)
    }
  }
}
