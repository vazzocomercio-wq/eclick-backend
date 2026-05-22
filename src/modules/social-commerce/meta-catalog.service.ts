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

// Scopes pra Catalog + WhatsApp Business + Instagram Shopping.
//
// IMPORTANTE — modelo de login: usamos "Instagram API with Facebook Login"
// (o app principal, NAO o app separado "e-Click-IG" do Instagram Login).
// Por isso os scopes sao os classicos `instagram_*` (NAO `instagram_business_*`,
// que pertencem ao modelo Instagram Login e quebrariam o OAuth se misturados).
// Os `instagram_*` ficam disponiveis depois de adicionar o caso de uso
// "API do Instagram (com login do Facebook)" no painel do app.
//
// whatsapp_business_management: vincular catalog ao WABA + ler config
// whatsapp_business_messaging: enviar produtos em conversas (W4)
// instagram_basic: ler conta IG + midia (posts/reels) — Frente 2 S1
// instagram_shopping_tag_products: taguear produtos em posts — Frente 2 S2
// instagram_content_publish: publicar posts do e-Click (Frente 2 modo B)
// pages_show_list: necessario pro fluxo IG (listar Pages com IG vinculado)
//
// Frente 4 (DM no Active) vai precisar de instagram_manage_messages +
// instagram_manage_comments — adicionar quando construir (re-OAuth na epoca).
const META_SCOPES = [
  'catalog_management',
  'business_management',
  'pages_read_engagement',
  'pages_show_list',
  'whatsapp_business_management',
  'whatsapp_business_messaging',
  'instagram_basic',
  'instagram_shopping_tag_products',
  'instagram_content_publish',
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
      // Força a Meta a RE-EXIBIR o diálogo de permissões mesmo se o app já
      // estiver autorizado. Sem isso, ao adicionar scopes novos (ex: os do
      // Instagram) a Meta pula o consent e devolve token com os scopes
      // ANTIGOS — o usuário "reconecta" mas nada muda.
      auth_type:     'rerequest',
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
      .select('id, external_catalog_id, status')
      .eq('organization_id', stateRow.organization_id)
      .eq('channel', 'instagram_shop')
      .maybeSingle()

    let channelId: string
    if (existing?.id) {
      // Re-OAuth (renovar token / adicionar scopes IG): se o canal JA tem
      // catalog configurado, preservar 'connected' — senao o re-OAuth
      // derrubaria o catalogo que ja funciona pra 'connecting' (requireConnected
      // exige 'connected', quebraria sync + widget ate refazer o setup).
      const keepConnected = Boolean(existing.external_catalog_id) && existing.status === 'connected'
      const { error: updErr } = await supabaseAdmin
        .from('social_commerce_channels')
        .update({
          access_token:     accessToken,
          token_expires_at: expiresAt,
          status:           keepConnected ? 'connected' : 'connecting',
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

  // ── Instagram Shopping (Frente 2) ────────────────────────────────────────

  /** Resolve o IG Business Account de uma Page (id + username + foto).
   *  Precisa do scope instagram_basic. Retorna null se a Page nao tem IG. */
  async getInstagramAccount(accessToken: string, pageId: string): Promise<{
    id: string; username?: string; profile_picture_url?: string; name?: string
  } | null> {
    const url = `${GRAPH_API_BASE}/${pageId}?fields=instagram_business_account{id,username,name,profile_picture_url}&access_token=${accessToken}`
    const res = await fetch(url)
    const body = await res.json() as {
      instagram_business_account?: { id: string; username?: string; name?: string; profile_picture_url?: string }
      error?: { message?: string }
    }
    if (!res.ok) throw new BadRequestException(`Meta getInstagramAccount: ${body.error?.message ?? 'erro'}`)
    return body.instagram_business_account ?? null
  }

  /** Lista mídia (posts/reels) de um IG Business Account.
   *  Precisa instagram_basic. `after` = cursor de paginação. */
  async listInstagramMedia(accessToken: string, igUserId: string, limit = 25, after?: string): Promise<{
    data: Array<{
      id: string
      media_type: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM'
      media_url?: string
      thumbnail_url?: string
      caption?: string
      permalink?: string
      timestamp?: string
    }>
    after?: string
  }> {
    const fields = 'id,media_type,media_url,thumbnail_url,caption,permalink,timestamp'
    let url = `${GRAPH_API_BASE}/${igUserId}/media?fields=${fields}&limit=${limit}&access_token=${accessToken}`
    if (after) url += `&after=${encodeURIComponent(after)}`
    const res = await fetch(url)
    const body = await res.json() as {
      data?: Array<{ id: string; media_type: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM'; media_url?: string; thumbnail_url?: string; caption?: string; permalink?: string; timestamp?: string }>
      paging?: { cursors?: { after?: string } }
      error?: { message?: string }
    }
    if (!res.ok) throw new BadRequestException(`Meta listInstagramMedia: ${body.error?.message ?? 'erro'}`)
    return { data: body.data ?? [], after: body.paging?.cursors?.after }
  }

  /** Lista produtos do catálogo Meta com o `id` NUMÉRICO (necessário pra
   *  product_tags do Instagram — o SKU/retailer_id NAO funciona la). Pagina
   *  até `max`. Retorna id (numerico), retailer_id (sku), name, image, price. */
  async listCatalogProducts(accessToken: string, catalogId: string, max = 500): Promise<Array<{
    id: string; retailer_id?: string; name?: string; image_url?: string; price?: string
  }>> {
    const out: Array<{ id: string; retailer_id?: string; name?: string; image_url?: string; price?: string }> = []
    let url: string | null = `${GRAPH_API_BASE}/${catalogId}/products?fields=id,retailer_id,name,image_url,price&limit=100&access_token=${accessToken}`
    while (url && out.length < max) {
      const res = await fetch(url)
      const body = await res.json() as {
        data?: Array<{ id: string; retailer_id?: string; name?: string; image_url?: string; price?: string }>
        paging?: { next?: string }
        error?: { message?: string }
      }
      if (!res.ok) throw new BadRequestException(`Meta listCatalogProducts: ${body.error?.message ?? 'erro'}`)
      out.push(...(body.data ?? []))
      url = body.paging?.next ?? null
    }
    return out.slice(0, max)
  }

  /** Lê os product tags ja aplicados num media. Precisa instagram_shopping_tag_products. */
  async getMediaProductTags(accessToken: string, mediaId: string): Promise<Array<{
    product_id: string; merchant_id?: string; x?: number; y?: number; name?: string
  }>> {
    const url = `${GRAPH_API_BASE}/${mediaId}/product_tags?access_token=${accessToken}`
    const res = await fetch(url)
    const body = await res.json() as {
      data?: Array<{ product_id: string; merchant_id?: string; x?: number; y?: number; name?: string }>
      error?: { message?: string }
    }
    if (!res.ok) throw new BadRequestException(`Meta getMediaProductTags: ${body.error?.message ?? 'erro'}`)
    return body.data ?? []
  }

  /** Aplica product tags num media JA publicado. Precisa
   *  instagram_shopping_tag_products. Para IMAGE: x,y relativos 0-1.
   *  Para CAROUSEL/VIDEO a Meta ignora x,y. */
  async tagProductsOnMedia(accessToken: string, mediaId: string, tags: Array<{
    product_id: string; x?: number; y?: number
  }>): Promise<{ success: boolean }> {
    const url = `${GRAPH_API_BASE}/${mediaId}/product_tags`
    const params = new URLSearchParams({
      access_token: accessToken,
      updated_tags: JSON.stringify(tags.map(t => ({
        product_id: t.product_id,
        ...(t.x != null && t.y != null ? { x: t.x, y: t.y } : {}),
      }))),
    })
    const res = await fetch(`${url}?${params.toString()}`, { method: 'POST' })
    const body = await res.json() as { success?: boolean; error?: { message?: string } }
    if (!res.ok) throw new BadRequestException(`Meta tagProductsOnMedia: ${body.error?.message ?? 'erro'}`)
    return { success: Boolean(body.success ?? true) }
  }

  /** Remove product tags de um media. */
  async untagProductsOnMedia(accessToken: string, mediaId: string, productIds: string[]): Promise<{ success: boolean }> {
    const url = `${GRAPH_API_BASE}/${mediaId}/product_tags`
    const params = new URLSearchParams({
      access_token:   accessToken,
      deleted_tags:   JSON.stringify(productIds.map(id => ({ product_id: id }))),
    })
    const res = await fetch(`${url}?${params.toString()}`, { method: 'DELETE' })
    const body = await res.json() as { success?: boolean; error?: { message?: string } }
    if (!res.ok) throw new BadRequestException(`Meta untagProductsOnMedia: ${body.error?.message ?? 'erro'}`)
    return { success: Boolean(body.success ?? true) }
  }

  /** Lista catálogos da Business Manager do user (precisa business_management).
   *
   *  Com `businessId` → chamada direta retorna { data: [{id, name}] }.
   *  Sem `businessId` → lista businesses do user, cada um com seus catalogs
   *  aninhados em `owned_product_catalogs.data`. Aplanamos pra Array<{id,name}>
   *  pra o frontend ter um shape unico. */
  async listCatalogs(accessToken: string, businessId?: string): Promise<Array<{ id: string; name: string }>> {
    if (businessId) {
      const url = `${GRAPH_API_BASE}/${businessId}/owned_product_catalogs?fields=id,name&access_token=${accessToken}`
      const res = await fetch(url)
      const body = await res.json() as { data?: Array<{ id: string; name: string }>; error?: { message?: string } }
      if (!res.ok) throw new BadRequestException(`Meta listCatalogs: ${body.error?.message ?? 'erro'}`)
      return body.data ?? []
    }
    // Sem businessId: lista businesses do user com catalogs aninhados
    const url = `${GRAPH_API_BASE}/me/businesses?fields=id,name,owned_product_catalogs{id,name}&access_token=${accessToken}`
    const res = await fetch(url)
    const body = await res.json() as {
      data?: Array<{
        id: string
        name?: string
        owned_product_catalogs?: { data?: Array<{ id: string; name: string }> }
      }>
      error?: { message?: string }
    }
    if (!res.ok) throw new BadRequestException(`Meta listCatalogs: ${body.error?.message ?? 'erro'}`)
    const flat: Array<{ id: string; name: string }> = []
    for (const biz of body.data ?? []) {
      const bizLabel = biz.name ?? ''
      for (const cat of biz.owned_product_catalogs?.data ?? []) {
        // Prefixa com nome do business pra clarear quando ha homonimos
        // ("Catalog" em 3 businesses diferentes). Quando nao tem nome
        // do business, devolve so o nome do catalog.
        const name = bizLabel ? `${cat.name} — ${bizLabel}` : cat.name
        flat.push({ id: cat.id, name })
      }
    }
    return flat
  }

  /** Batch CREATE/UPDATE de produtos no catálogo Meta. Cada request item
   *  tem method ('CREATE'|'UPDATE'|'DELETE') + retailer_id (sku/uuid) + data.
   *
   *  ⚠️ items_batch tem 2 pegadinhas que custaram caro (2026-05-21):
   *   1. O retailer id vai DENTRO de `data` como `id` — NAO `retailer_id`
   *      no nivel do request. Sem isso a Meta responde HTTP 200 mas com
   *      `validation_status: [{errors:[{message:"Can not find required
   *      field id"}]}]` e NAO enfileira nada (handles vazio, catalog vazio).
   *   2. Erros de validacao vem em `validation_status[]`, NAO em `errors[]`.
   *      Se so olhar `body.errors`, o erro passa silencioso e o caller
   *      acha que deu certo. */
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
        // item_type obrigatorio NO TOP-LEVEL do batch (nao em item.data).
        // Sem ele: (#100) The parameter item_type is required.
        item_type: 'PRODUCT_ITEM',
        requests: items.map(i => ({
          method: i.method,
          // id (retailer id) vai DENTRO de data — ver pegadinha #1 acima
          data:   { ...(i.data ?? {}), id: i.retailer_id },
        })),
      }),
    })
    const body = await res.json() as {
      handles?: string[]
      error?: { message?: string }
      errors?: Array<{ message?: string }>
      validation_status?: Array<{ errors?: Array<{ message?: string }> }>
    }
    if (!res.ok) {
      throw new BadRequestException(`Meta batchUpdate: ${body.error?.message ?? 'erro'}`)
    }

    // Coleta erros de validacao (pegadinha #2). So entram itens com erro real.
    const validationErrors: Array<{ message?: string }> = []
    for (const v of body.validation_status ?? []) {
      for (const e of v.errors ?? []) validationErrors.push({ message: e.message })
    }

    return {
      handles: body.handles,
      errors:  validationErrors.length > 0 ? validationErrors : body.errors,
    }
  }

  /** Helper pra logar errors do Graph API com diagnostic completo. */
  logGraphError(context: string, channel: SocialCommerceChannelRow, err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    this.logger.error(`[meta.${context}] org=${channel.organization_id} channel=${channel.id}: ${msg}`)
  }

  // ── WhatsApp Business — vincular catalog ao WABA ─────────────────────

  /** Lista WhatsApp Business Accounts do user.
   *
   *  Cada Business Manager pode ter N WABAs, cada WABA tem N numeros de
   *  telefone. O catalog Meta (FB+IG+WhatsApp compartilham) precisa ser
   *  vinculado ao WABA pra aparecer dentro do WhatsApp Business.
   *
   *  Requer scope `whatsapp_business_management`. Quando o token nao tem,
   *  retorna [] (sem lancar — o caller exibe "conecte com permissoes
   *  expandidas"). */
  async listWabas(accessToken: string): Promise<Array<{
    id:               string
    name:             string
    business_id:      string | null
    phone_numbers?:   Array<{ id: string; display_phone_number: string; verified_name: string }>
  }>> {
    const url = `${GRAPH_API_BASE}/me/businesses?fields=id,name,owned_whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name}}&access_token=${accessToken}`
    const res = await fetch(url)
    const body = await res.json() as {
      data?: Array<{
        id: string
        name: string
        owned_whatsapp_business_accounts?: {
          data?: Array<{
            id: string
            name: string
            phone_numbers?: { data?: Array<{ id: string; display_phone_number: string; verified_name: string }> }
          }>
        }
      }>
      error?: { message?: string }
    }
    if (!res.ok) {
      // Permissoes ausentes vem com codigos 10/200/etc. Logamos e devolvemos [].
      this.logger.warn(`[meta.listWabas] ${body.error?.message ?? 'erro'}`)
      return []
    }
    const out: Array<{
      id: string; name: string; business_id: string | null
      phone_numbers?: Array<{ id: string; display_phone_number: string; verified_name: string }>
    }> = []
    for (const biz of body.data ?? []) {
      for (const waba of biz.owned_whatsapp_business_accounts?.data ?? []) {
        out.push({
          id:            waba.id,
          name:          waba.name,
          business_id:   biz.id ?? null,
          phone_numbers: waba.phone_numbers?.data ?? [],
        })
      }
    }
    return out
  }

  /** Vincula um catalog (do Meta Commerce Manager) ao WhatsApp Business
   *  Account. Apos isso, os produtos do catalog aparecem no WhatsApp
   *  Business do lojista + podem ser enviados em conversa via Cloud API
   *  ou Z-API (interactive `product` / `product_list`).
   *
   *  POST /{waba_id}/product_catalogs?catalog_id=...
   *
   *  Idempotente do lado do Meta — chamar 2x devolve OK; pra trocar
   *  catalog, primeiro desvincular (DELETE) e religar. */
  async linkCatalogToWaba(accessToken: string, wabaId: string, catalogId: string): Promise<{ success: boolean }> {
    const url = `${GRAPH_API_BASE}/${wabaId}/product_catalogs`
    const params = new URLSearchParams({ catalog_id: catalogId, access_token: accessToken })
    const res = await fetch(`${url}?${params.toString()}`, { method: 'POST' })
    const body = await res.json() as { success?: boolean; error?: { message?: string } }
    if (!res.ok) throw new BadRequestException(`Meta linkCatalogToWaba: ${body.error?.message ?? 'erro'}`)
    return { success: Boolean(body.success ?? true) }
  }

  /** Desvincula o catalog atual do WABA. */
  async unlinkCatalogFromWaba(accessToken: string, wabaId: string, catalogId: string): Promise<{ success: boolean }> {
    const url = `${GRAPH_API_BASE}/${wabaId}/product_catalogs`
    const params = new URLSearchParams({ catalog_id: catalogId, access_token: accessToken })
    const res = await fetch(`${url}?${params.toString()}`, { method: 'DELETE' })
    const body = await res.json() as { success?: boolean; error?: { message?: string } }
    if (!res.ok) throw new BadRequestException(`Meta unlinkCatalog: ${body.error?.message ?? 'erro'}`)
    return { success: Boolean(body.success ?? true) }
  }

  /** Le o catalog vinculado ao WABA atualmente. */
  async getLinkedCatalog(accessToken: string, wabaId: string): Promise<{ id: string; name: string } | null> {
    const url = `${GRAPH_API_BASE}/${wabaId}/product_catalogs?fields=id,name&access_token=${accessToken}`
    const res = await fetch(url)
    const body = await res.json() as { data?: Array<{ id: string; name: string }>; error?: { message?: string } }
    if (!res.ok) return null
    return (body.data && body.data[0]) ?? null
  }
}
