import {
  Injectable,
  Logger,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common'
import * as crypto from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import { encryptConfig, decryptConfig } from '../marketplace/crypto.util'

/**
 * TikTok Shop (app Personalizado) — Fase 1: OAuth da loja.
 *
 * Fluxo: front pede /tiktok-shop/oauth/auth-url → redireciona o lojista pra
 * services.tiktokshop.com/open/authorize?service_id=...&state=... → TikTok
 * chama nosso callback com code+state → trocamos por access/refresh token e
 * salvamos CIFRADO em tiktok_shop_credentials.
 *
 * A troca de token NÃO é assinada (endpoint de auth). A assinatura HMAC das
 * APIs de negócio (pedidos/produtos) entra na Fase 2.
 *
 * Docs: https://partner.tiktokshop.com/docv2/page/...(authorization)
 */

const TTS_AUTHORIZE = 'https://services.tiktokshop.com/open/authorize'
const TTS_TOKEN = 'https://auth.tiktok-shops.com/api/v2/token/get'

interface TtsTokenData {
  access_token?: string
  access_token_expire_in?: number
  refresh_token?: string
  refresh_token_expire_in?: number
  open_id?: string
  seller_name?: string
  seller_base_region?: string
  granted_scopes?: string[]
}

interface TtsTokenResponse {
  code?: number
  message?: string
  data?: TtsTokenData
}

interface OAuthStateRow {
  organization_id: string
  redirect_to: string | null
}

@Injectable()
export class TikTokShopService {
  private readonly logger = new Logger(TikTokShopService.name)

  private env(): { appKey: string; appSecret: string; serviceId: string } {
    const appKey = process.env.TIKTOK_SHOP_APP_KEY
    const appSecret = process.env.TIKTOK_SHOP_APP_SECRET
    const serviceId = process.env.TIKTOK_SHOP_SERVICE_ID
    if (!appKey || !appSecret || !serviceId) {
      throw new HttpException(
        'TikTok Shop não está configurado no servidor (app_key/app_secret/service_id).',
        HttpStatus.INTERNAL_SERVER_ERROR,
      )
    }
    return { appKey, appSecret, serviceId }
  }

  isConfigured(): boolean {
    return !!(
      process.env.TIKTOK_SHOP_APP_KEY &&
      process.env.TIKTOK_SHOP_APP_SECRET &&
      process.env.TIKTOK_SHOP_SERVICE_ID
    )
  }

  /** Gera state CSRF, persiste em oauth_state e devolve a URL de autorização. */
  async buildAuthorizeUrl(
    orgId: string,
    userId: string,
    redirectTo?: string,
  ): Promise<{ authorize_url: string }> {
    const { serviceId } = this.env()
    const state = crypto.randomBytes(48).toString('base64url')

    const { error } = await supabaseAdmin.from('oauth_state').insert({
      organization_id: orgId,
      user_id: userId,
      provider: 'tiktok_shop',
      state,
      redirect_to: redirectTo ?? null,
    })
    if (error) {
      this.logger.error(`[tts.oauth] persist state falhou: ${error.message}`)
      throw new HttpException(
        'Falha ao iniciar OAuth — tente novamente',
        HttpStatus.INTERNAL_SERVER_ERROR,
      )
    }

    const params = new URLSearchParams({ service_id: serviceId, state })
    return { authorize_url: `${TTS_AUTHORIZE}?${params.toString()}` }
  }

  /** Callback: valida o state, troca o code por token e salva cifrado. */
  async exchangeCode(
    code: string,
    state: string,
  ): Promise<{ orgId: string; sellerName: string | null; redirect_to: string | null }> {
    const { appKey, appSecret } = this.env()

    const { data: stateRow, error } = await supabaseAdmin
      .from('oauth_state')
      .select('organization_id, redirect_to')
      .eq('state', state)
      .eq('provider', 'tiktok_shop')
      .maybeSingle<OAuthStateRow>()
    if (error || !stateRow) {
      throw new BadRequestException('state inválido ou expirado')
    }
    await supabaseAdmin.from('oauth_state').delete().eq('state', state)

    const params = new URLSearchParams({
      app_key: appKey,
      app_secret: appSecret,
      auth_code: code,
      grant_type: 'authorized_code',
    })
    const res = await fetch(`${TTS_TOKEN}?${params.toString()}`, {
      signal: AbortSignal.timeout(20_000),
    })
    const json = (await res.json()) as TtsTokenResponse
    if (!res.ok || json.code !== 0 || !json.data?.access_token) {
      throw new BadRequestException(
        `TikTok Shop token exchange falhou: ${json.message ?? `HTTP ${res.status}`}`,
      )
    }

    await this.persist(stateRow.organization_id, json.data, json)
    return {
      orgId: stateRow.organization_id,
      sellerName: json.data.seller_name ?? null,
      redirect_to: stateRow.redirect_to ?? null,
    }
  }

  private async persist(
    orgId: string,
    d: TtsTokenData,
    raw: unknown,
  ): Promise<void> {
    const credentials_encrypted = encryptConfig({
      access_token: d.access_token,
      refresh_token: d.refresh_token,
    })
    if (!credentials_encrypted) {
      throw new BadRequestException('Falha ao cifrar credenciais do TikTok Shop')
    }
    const now = Date.now()
    const accessExp = d.access_token_expire_in
      ? new Date(now + d.access_token_expire_in * 1000).toISOString()
      : null
    const refreshExp = d.refresh_token_expire_in
      ? new Date(now + d.refresh_token_expire_in * 1000).toISOString()
      : null

    const { error } = await supabaseAdmin.from('tiktok_shop_credentials').upsert(
      {
        organization_id: orgId,
        open_id: d.open_id ?? null,
        seller_name: d.seller_name ?? null,
        region: d.seller_base_region ?? null,
        credentials_encrypted,
        scopes: d.granted_scopes ?? [],
        access_expires_at: accessExp,
        refresh_expires_at: refreshExp,
        status: 'connected',
        raw: raw as Record<string, unknown>,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id' },
    )
    if (error) {
      throw new BadRequestException(
        `Falha ao salvar credencial TikTok Shop: ${error.message}`,
      )
    }
  }

  /** Status pra UI. */
  async getStatus(orgId: string): Promise<{
    configured_globally: boolean
    connected: boolean
    seller_name: string | null
    region: string | null
    access_expires_at: string | null
  }> {
    const { data } = await supabaseAdmin
      .from('tiktok_shop_credentials')
      .select('seller_name, region, status, access_expires_at')
      .eq('organization_id', orgId)
      .maybeSingle<{
        seller_name: string | null
        region: string | null
        status: string
        access_expires_at: string | null
      }>()
    return {
      configured_globally: this.isConfigured(),
      connected: !!data && data.status === 'connected',
      seller_name: data?.seller_name ?? null,
      region: data?.region ?? null,
      access_expires_at: data?.access_expires_at ?? null,
    }
  }

  async disconnect(orgId: string): Promise<{ ok: true }> {
    await supabaseAdmin
      .from('tiktok_shop_credentials')
      .delete()
      .eq('organization_id', orgId)
    return { ok: true }
  }

  /** Access token decifrado — base pras Fases 2+ (chamadas de negócio). */
  async getAccessToken(orgId: string): Promise<string | null> {
    const { data } = await supabaseAdmin
      .from('tiktok_shop_credentials')
      .select('credentials_encrypted')
      .eq('organization_id', orgId)
      .maybeSingle<{ credentials_encrypted: string }>()
    if (!data?.credentials_encrypted) return null
    const dec = decryptConfig(data.credentials_encrypted)
    const token = dec?.access_token
    return typeof token === 'string' ? token : null
  }
}
