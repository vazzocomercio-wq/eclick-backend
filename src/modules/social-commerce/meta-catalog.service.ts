import { Injectable, Logger, HttpException, HttpStatus, BadRequestException } from '@nestjs/common'
import * as crypto from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import type {
  SocialCommerceChannelRow,
  MetaProductData,
} from './social-commerce.types'

/** Onda 3 / S2 — Meta Catalog API client.
 *
 * Wraps Graph API (v19.0) calls necessários pra:
 *   - OAuth start/callback
 *   - List Pages + Instagram Business Accounts do user
 *   - Create / link catalog
 *   - Batch CREATE/UPDATE de produtos no catálogo
 *
 * Sem META_APP_ID / META_APP_SECRET / META_REDIRECT_URI no env, retorna 503
 * (mesmo padrão de canva-oauth.service).
 *
 * Tokens são armazenados em social_commerce_channels.access_token.
 * TODO produção: cifrar com KMS antes de persistir.
 */

const GRAPH_API_BASE   = 'https://graph.facebook.com/v19.0'
const META_AUTH_URL    = 'https://www.facebook.com/v19.0/dialog/oauth'
const META_TOKEN_URL   = 'https://graph.facebook.com/v19.0/oauth/access_token'

// Scopes mínimos pra Catalog Management
const META_SCOPES = [
  'catalog_management',
  'business_management',
  'pages_read_engagement',
  'instagram_basic',
].join(',')

@Injectable()
export class MetaCatalogService {
  private readonly logger = new Logger(MetaCatalogService.name)

  // ── Env / config ────────────────────────────────────────────────────────

  private getEnv(): { appId: string; appSecret: string; redirectUri: string } {
    const appId       = process.env.META_APP_ID
    const appSecret   = process.env.META_APP_SECRET
    const redirectUri = process.env.META_REDIRECT_URI
    if (!appId || !appSecret || !redirectUri) {
      throw new HttpException(
        'Integração Meta não configurada — defina META_APP_ID, META_APP_SECRET, META_REDIRECT_URI',
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }
    return { appId, appSecret, redirectUri }
  }

  isConfigured(): boolean {
    return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_REDIRECT_URI)
  }

  // ── OAuth ────────────────────────────────────────────────────────────────

  /** Gera state CSRF aleatório (96 bytes) e persiste em oauth_state. */
  async buildAuthorizeUrl(orgId: string, userId: string, redirectTo?: string): Promise<{ authorize_url: string }> {
    const { appId, redirectUri } = this.getEnv()

    const state = crypto.randomBytes(96).toString('base64url')

    const { error } = await supabaseAdmin.from('oauth_state').insert({
      organization_id: orgId,
      user_id:         userId,
      provider:        'meta',
      state,
      redirect_to:     redirectTo ?? null,
    })
    if (error) {
      this.logger.error(`[meta.oauth] persist state falhou: ${error.message}`)
      throw new HttpException('Falha ao iniciar OAuth — tente novamente', HttpStatus.INTERNAL_SERVER_ERROR)
    }

    const params = new URLSearchParams({
      client_id:     appId,
      response_type: 'code',
      scope:         META_SCOPES,
      state,
      redirect_uri:  redirectUri,
    })
    return { authorize_url: `${META_AUTH_URL}?${params.toString()}` }
  }

  /** Troca code por access_token (long-lived). Cria/atualiza linha em
   *  social_commerce_channels com status='connected'. */
  async exchangeCode(code: string, state: string): Promise<{
    channelId:   string
    redirect_to: string | null
  }> {
    const { appId, appSecret, redirectUri } = this.getEnv()

    // Valida state
    const { data: stateRow, error } = await supabaseAdmin
      .from('oauth_state')
      .select('*')
      .eq('state', state)
      .eq('provider', 'meta')
      .maybeSingle()
    if (error || !stateRow) {
      throw new BadRequestException('state inválido ou expirado')
    }

    // Apaga state usado (single-use)
    await supabaseAdmin.from('oauth_state').delete().eq('state', state)

    // Short-lived token primeiro
    const params = new URLSearchParams({
      client_id:     appId,
      client_secret: appSecret,
      code,
      redirect_uri:  redirectUri,
    })
    const r1 = await fetch(`${META_TOKEN_URL}?${params.toString()}`)
    const t1 = await r1.json() as {
      access_token?: string
      token_type?:   string
      expires_in?:   number
      error?:        { message?: string }
    }
    if (!r1.ok || !t1.access_token) {
      throw new BadRequestException(`Meta token exchange falhou: ${t1.error?.message ?? 'erro desconhecido'}`)
    }

    // Long-lived token (60 dias) — Meta exige refresh do short-lived
    const params2 = new URLSearchParams({
      grant_type:        'fb_exchange_token',
      client_id:         appId,
      client_secret:     appSecret,
      fb_exchange_token: t1.access_token,
    })
    const r2 = await fetch(`${META_TOKEN_URL}?${params2.toString()}`)
    const t2 = await r2.json() as {
      access_token?: string
      expires_in?:   number
      error?:        { message?: string }
    }
    if (!r2.ok || !t2.access_token) {
      this.logger.warn(`[meta.oauth] long-lived exchange falhou (${t2.error?.message}) — usando short-lived`)
    }

    const accessToken = t2.access_token ?? t1.access_token
    const expiresIn   = t2.expires_in   ?? t1.expires_in ?? 3600
    const expiresAt   = new Date(Date.now() + expiresIn * 1000).toISOString()

    // Upsert na tabela de channels (Instagram Shop por padrão; user pode
    // depois selecionar Page+IG via /setup-catalog)
    const { data: existing } = await supabaseAdmin
      .from('social_commerce_channels')
      .select('id')
      .eq('organization_id', stateRow.organization_id)
      .eq('channel', 'instagram_shop')
      .maybeSingle()

    let channelId: string
    if (existing?.id) {
      const { error: updErr } = await supabaseAdmin
        .from('social_commerce_channels')
        .update({
          access_token:     accessToken,
          token_expires_at: expiresAt,
          status:           'connecting',
          last_error:       null,
        })
        .eq('id', existing.id)
      if (updErr) throw new BadRequestException(`Erro ao atualizar canal: ${updErr.message}`)
      channelId = existing.id
    } else {
      const { data: created, error: insErr } = await supabaseAdmin
        .from('social_commerce_channels')
        .insert({
          organization_id:  stateRow.organization_id,
          channel:          'instagram_shop',
          access_token:     accessToken,
          token_expires_at: expiresAt,
          status:           'connecting',
        })
        .select('id')
        .maybeSingle()
      if (insErr || !created?.id) throw new BadRequestException(`Erro ao criar canal: ${insErr?.message ?? 'sem id'}`)
      channelId = created.id
    }

    return { channelId, redirect_to: stateRow.redirect_to ?? null }
  }

  // ── Graph API ────────────────────────────────────────────────────────────

  /** Lista Pages que o user gerencia. Necessário pra escolher qual Page
   *  vincular ao Catalog (cada Page pode ter 1 IG Business Account). */
  async listPages(accessToken: string): Promise<Array<{ id: string; name: string; instagram_business_account?: { id: string } }>> {
    const url = `${GRAPH_API_BASE}/me/accounts?fields=id,name,instagram_business_account&access_token=${accessToken}`
    const res = await fetch(url)
    const body = await res.json() as {
      data?: Array<{ id: string; name: string; instagram_business_account?: { id: string } }>
      error?: { message?: string }
    }
    if (!res.ok) throw new BadRequestException(`Meta listPages: ${body.error?.message ?? 'erro'}`)
    return body.data ?? []
  }

  /** Lista catálogos da Business Manager do user (precisa business_management). */
  async listCatalogs(accessToken: string, businessId?: string): Promise<Array<{ id: string; name: string }>> {
    const path = businessId
      ? `${GRAPH_API_BASE}/${businessId}/owned_product_catalogs?fields=id,name&access_token=${accessToken}`
      : `${GRAPH_API_BASE}/me/businesses?fields=owned_product_catalogs{id,name}&access_token=${accessToken}`
    const res = await fetch(path)
    const body = await res.json() as { data?: Array<{ id: string; name: string }>; error?: { message?: string } }
    if (!res.ok) throw new BadRequestException(`Meta listCatalogs: ${body.error?.message ?? 'erro'}`)
    return body.data ?? []
  }

  /** Batch CREATE/UPDATE de produtos no catálogo Meta. Cada request item
   *  tem method ('CREATE'|'UPDATE'|'DELETE') + retailer_id (sku/uuid) + data. */
  async batchUpdateProducts(
    accessToken: string,
    catalogId: string,
    items: Array<{
      method:      'CREATE' | 'UPDATE' | 'DELETE'
      retailer_id: string
      data?:       MetaProductData
    }>,
  ): Promise<{
    handles?:   string[]
    errors?:    Array<{ message?: string }>
  }> {
    const url = `${GRAPH_API_BASE}/${catalogId}/items_batch`
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        access_token: accessToken,
        requests: items.map(i => ({
          method:      i.method,
          retailer_id: i.retailer_id,
          data:        i.data ?? {},
        })),
      }),
    })
    const body = await res.json() as {
      handles?: string[]
      error?: { message?: string }
      errors?: Array<{ message?: string }>
    }
    if (!res.ok) {
      throw new BadRequestException(`Meta batchUpdate: ${body.error?.message ?? 'erro'}`)
    }
    return { handles: body.handles, errors: body.errors }
  }

  /** Helper pra logar errors do Graph API com diagnostic completo. */
  logGraphError(context: string, channel: SocialCommerceChannelRow, err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    this.logger.error(`[meta.${context}] org=${channel.organization_id} channel=${channel.id}: ${msg}`)
  }
}
