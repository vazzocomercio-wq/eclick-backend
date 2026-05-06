import { Injectable, Logger, HttpException, HttpStatus, BadRequestException } from '@nestjs/common'
import * as crypto from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import type { AdsCampaign } from './ads-campaigns.types'

/**
 * Onda 3 / S6 — Meta Marketing API (Facebook/Instagram Ads).
 *
 * Wraps Graph API v19.0 pra:
 *   - OAuth dialog + token exchange (escopo ads_management + ads_read)
 *   - Listar Ad Accounts do user
 *   - Criar Campaign + Ad Set + Ad (3 níveis Meta)
 *   - Sync de insights (impressions/clicks/spend/conversions/roas)
 *
 * Sem META_APP_ID/META_APP_SECRET/META_REDIRECT_URI no env, retorna 503.
 *
 * NOTA: usa o MESMO META_APP_ID do Catalog (S2). O scope é diferente —
 * pra Ads precisamos `ads_management,ads_read` ao invés de
 * `catalog_management`. User precisa aceitar o consent dos dois quando
 * conecta. Em prod, o admin pode separar em 2 apps Meta distintos via
 * envs separadas (TODO).
 *
 * Tokens armazenados em api_credentials (org-level, key=META_ADS_TOKEN).
 */

const GRAPH_API_BASE   = 'https://graph.facebook.com/v19.0'
const META_AUTH_URL    = 'https://www.facebook.com/v19.0/dialog/oauth'
const META_TOKEN_URL   = 'https://graph.facebook.com/v19.0/oauth/access_token'

const ADS_SCOPES = ['ads_management', 'ads_read', 'business_management'].join(',')

interface StoredAdsToken {
  access_token: string
  expires_at:   number  // ms unix
  ad_account_id?: string
}

@Injectable()
export class MetaAdsService {
  private readonly logger = new Logger(MetaAdsService.name)

  private getEnv(): { appId: string; appSecret: string; redirectUri: string } {
    const appId       = process.env.META_APP_ID
    const appSecret   = process.env.META_APP_SECRET
    const redirectUri = process.env.META_ADS_REDIRECT_URI ?? process.env.META_REDIRECT_URI
    if (!appId || !appSecret || !redirectUri) {
      throw new HttpException(
        'Meta Ads não configurado — defina META_APP_ID, META_APP_SECRET e META_ADS_REDIRECT_URI',
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }
    return { appId, appSecret, redirectUri }
  }

  isConfigured(): boolean {
    return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET)
  }

  // ── OAuth ───────────────────────────────────────────────────────

  async buildAuthorizeUrl(orgId: string, userId: string, redirectTo?: string): Promise<{ authorize_url: string }> {
    const { appId, redirectUri } = this.getEnv()
    const state = crypto.randomBytes(96).toString('base64url')

    const { error } = await supabaseAdmin.from('oauth_state').insert({
      organization_id: orgId,
      user_id:         userId,
      provider:        'meta_ads',
      state,
      redirect_to:     redirectTo ?? null,
    })
    if (error) {
      this.logger.error(`[meta-ads] persist state falhou: ${error.message}`)
      throw new HttpException('Falha ao iniciar OAuth', HttpStatus.INTERNAL_SERVER_ERROR)
    }

    const params = new URLSearchParams({
      client_id:     appId,
      response_type: 'code',
      scope:         ADS_SCOPES,
      state,
      redirect_uri:  redirectUri,
    })
    return { authorize_url: `${META_AUTH_URL}?${params.toString()}` }
  }

  async exchangeCode(code: string, state: string): Promise<{ orgId: string; redirect_to: string | null }> {
    const { appId, appSecret, redirectUri } = this.getEnv()

    const { data: stateRow } = await supabaseAdmin
      .from('oauth_state')
      .select('*')
      .eq('state', state)
      .eq('provider', 'meta_ads')
      .maybeSingle()
    if (!stateRow) throw new BadRequestException('state inválido ou expirado')

    await supabaseAdmin.from('oauth_state').delete().eq('state', state)

    // Short → long-lived
    const r1 = await fetch(`${META_TOKEN_URL}?` + new URLSearchParams({
      client_id: appId, client_secret: appSecret, code, redirect_uri: redirectUri,
    }))
    const t1 = await r1.json() as { access_token?: string; expires_in?: number; error?: { message?: string } }
    if (!r1.ok || !t1.access_token) {
      throw new BadRequestException(`Meta Ads token: ${t1.error?.message ?? 'erro'}`)
    }

    const r2 = await fetch(`${META_TOKEN_URL}?` + new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: appId, client_secret: appSecret,
      fb_exchange_token: t1.access_token,
    }))
    const t2 = await r2.json() as { access_token?: string; expires_in?: number }
    const accessToken = t2.access_token ?? t1.access_token
    const expiresIn   = t2.expires_in   ?? t1.expires_in ?? 3600

    const stored: StoredAdsToken = {
      access_token: accessToken,
      expires_at:   Date.now() + expiresIn * 1000,
    }

    // Salva em api_credentials (key per-org)
    await supabaseAdmin
      .from('api_credentials')
      .upsert({
        organization_id: stateRow.organization_id,
        provider:        'meta_ads',
        credentials:     stored as unknown as Record<string, unknown>,
        is_active:       true,
      }, { onConflict: 'organization_id,provider' })

    return { orgId: stateRow.organization_id, redirect_to: stateRow.redirect_to ?? null }
  }

  async getStoredToken(orgId: string): Promise<StoredAdsToken | null> {
    const { data } = await supabaseAdmin
      .from('api_credentials')
      .select('credentials')
      .eq('organization_id', orgId)
      .eq('provider', 'meta_ads')
      .eq('is_active', true)
      .maybeSingle()
    if (!data) return null
    return data.credentials as unknown as StoredAdsToken
  }

  async disconnect(orgId: string): Promise<{ ok: true }> {
    await supabaseAdmin
      .from('api_credentials')
      .update({ is_active: false })
      .eq('organization_id', orgId)
      .eq('provider', 'meta_ads')
    return { ok: true }
  }

  // ── Ad Accounts ─────────────────────────────────────────────────

  async listAdAccounts(accessToken: string): Promise<Array<{ id: string; name: string; account_status: number; currency: string }>> {
    const url = `${GRAPH_API_BASE}/me/adaccounts?fields=id,name,account_status,currency&access_token=${accessToken}`
    const res = await fetch(url)
    const body = await res.json() as { data?: Array<{ id: string; name: string; account_status: number; currency: string }>; error?: { message?: string } }
    if (!res.ok) throw new BadRequestException(`Meta listAdAccounts: ${body.error?.message}`)
    return body.data ?? []
  }

  async setAdAccount(orgId: string, adAccountId: string): Promise<{ ok: true }> {
    const stored = await this.getStoredToken(orgId)
    if (!stored) throw new BadRequestException('Conecte Meta Ads primeiro')
    stored.ad_account_id = adAccountId
    await supabaseAdmin
      .from('api_credentials')
      .update({ credentials: stored as unknown as Record<string, unknown> })
      .eq('organization_id', orgId)
      .eq('provider', 'meta_ads')
    return { ok: true }
  }

  // ── Publish (cria Campaign + AdSet + Ad no Meta) ────────────────

  /** Publica campanha real no Meta. Retorna external_campaign_id +
   *  external_adset_id + external_ad_ids[] pra salvar em ads_campaigns. */
  async publish(orgId: string, c: AdsCampaign): Promise<{
    campaign_id: string
    adset_id:    string
    ad_ids:      string[]
  }> {
    const stored = await this.getStoredToken(orgId)
    if (!stored?.access_token) throw new BadRequestException('Meta Ads não conectado')
    if (!stored.ad_account_id)  throw new BadRequestException('Selecione uma Ad Account primeiro')

    const accountId = stored.ad_account_id.startsWith('act_') ? stored.ad_account_id : `act_${stored.ad_account_id}`

    // 1. Campaign
    const r1 = await fetch(`${GRAPH_API_BASE}/${accountId}/campaigns`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        name:        c.name,
        objective:   this.mapObjective(c.objective),
        status:      'PAUSED',  // sempre cria pausado — user libera no Meta UI
        special_ad_categories: [],
        access_token: stored.access_token,
      }),
    })
    const camp = await r1.json() as { id?: string; error?: { message?: string } }
    if (!r1.ok || !camp.id) throw new BadRequestException(`Meta create campaign: ${camp.error?.message}`)

    // 2. Ad Set
    const startTime = new Date(Date.now() + 60_000).toISOString()
    const endTime   = new Date(Date.now() + (c.duration_days * 24 * 60 * 60 * 1000)).toISOString()
    const r2 = await fetch(`${GRAPH_API_BASE}/${accountId}/adsets`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        name:                  `${c.name} - AdSet`,
        campaign_id:           camp.id,
        daily_budget:          Math.round(c.budget_daily_brl * 100), // centavos
        billing_event:         'IMPRESSIONS',
        optimization_goal:     this.mapOptimizationGoal(c.objective),
        bid_strategy:          'LOWEST_COST_WITHOUT_CAP',
        targeting:             c.targeting,
        start_time:            startTime,
        end_time:              endTime,
        status:                'PAUSED',
        access_token:          stored.access_token,
      }),
    })
    const adset = await r2.json() as { id?: string; error?: { message?: string } }
    if (!r2.ok || !adset.id) throw new BadRequestException(`Meta create adset: ${adset.error?.message}`)

    // 3. Ads (1 por variant)
    const adIds: string[] = []
    for (const copy of c.ad_copies) {
      const r3 = await fetch(`${GRAPH_API_BASE}/${accountId}/ads`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          name:      `${c.name} - var ${copy.variant}`,
          adset_id:  adset.id,
          creative:  {
            // shape mínimo: object_story_spec.link_data
            object_story_spec: {
              link_data: {
                message:       copy.primary_text,
                link:          c.destination_url ?? 'https://eclick.app.br',
                name:          copy.headline,
                description:   copy.description ?? '',
                call_to_action: { type: copy.cta },
              },
            },
          },
          status:    'PAUSED',
          access_token: stored.access_token,
        }),
      })
      const ad = await r3.json() as { id?: string; error?: { message?: string } }
      if (r3.ok && ad.id) adIds.push(ad.id)
      else this.logger.warn(`[meta-ads.publish] ad ${copy.variant} falhou: ${ad.error?.message}`)
    }

    return {
      campaign_id: camp.id,
      adset_id:    adset.id,
      ad_ids:      adIds,
    }
  }

  // ── Insights / Métricas ─────────────────────────────────────────

  /** Busca insights da campanha no Meta. Retorna shape compatível com
   *  ads_campaigns.metrics. */
  async fetchInsights(accessToken: string, campaignId: string): Promise<Record<string, unknown>> {
    const fields = [
      'impressions','clicks','ctr','cpc','spend','actions','action_values',
    ].join(',')
    const url = `${GRAPH_API_BASE}/${campaignId}/insights?fields=${fields}&date_preset=last_7d&access_token=${accessToken}`
    const res = await fetch(url)
    const body = await res.json() as {
      data?: Array<{
        impressions?:    string
        clicks?:         string
        ctr?:            string
        cpc?:            string
        spend?:          string
        actions?:        Array<{ action_type: string; value: string }>
        action_values?:  Array<{ action_type: string; value: string }>
      }>
      error?: { message?: string }
    }
    if (!res.ok) throw new BadRequestException(`Meta insights: ${body.error?.message}`)

    const row = body.data?.[0]
    if (!row) return { last_sync: new Date().toISOString() }

    const purchases = row.actions?.find(a => a.action_type === 'purchase')
    const revenue   = row.action_values?.find(a => a.action_type === 'purchase')

    const impressions = parseInt(row.impressions ?? '0', 10)
    const clicks      = parseInt(row.clicks      ?? '0', 10)
    const spend       = parseFloat(row.spend     ?? '0')
    const conversions = purchases ? parseInt(purchases.value, 10) : 0
    const conversionValue = revenue ? parseFloat(revenue.value) : 0
    const roas = spend > 0 ? conversionValue / spend : 0

    return {
      impressions,
      clicks,
      ctr:                  parseFloat(row.ctr ?? '0'),
      cpc_brl:              parseFloat(row.cpc ?? '0'),
      spend_brl:            spend,
      conversions,
      conversion_value_brl: conversionValue,
      roas,
      cpa_brl:              conversions > 0 ? spend / conversions : 0,
      last_sync:            new Date().toISOString(),
    }
  }

  // ── Helpers de mapeamento ───────────────────────────────────────

  private mapObjective(obj: AdsCampaign['objective']): string {
    const map: Record<string, string> = {
      traffic:        'OUTCOME_TRAFFIC',
      conversions:    'OUTCOME_SALES',
      catalog_sales:  'OUTCOME_SALES',
      engagement:     'OUTCOME_ENGAGEMENT',
      awareness:      'OUTCOME_AWARENESS',
      leads:          'OUTCOME_LEADS',
    }
    return map[obj] ?? 'OUTCOME_TRAFFIC'
  }

  private mapOptimizationGoal(obj: AdsCampaign['objective']): string {
    const map: Record<string, string> = {
      traffic:        'LINK_CLICKS',
      conversions:    'OFFSITE_CONVERSIONS',
      catalog_sales:  'OFFSITE_CONVERSIONS',
      engagement:     'POST_ENGAGEMENT',
      awareness:      'REACH',
      leads:          'LEAD_GENERATION',
    }
    return map[obj] ?? 'LINK_CLICKS'
  }
}
