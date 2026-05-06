import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { LlmService } from '../ai/llm.service'
import { supabaseAdmin } from '../../common/supabase'
import { MetaAdsService } from './meta-ads.service'
import {
  buildAdsCampaignPrompt,
  buildRegenerateCopiesPrompt,
} from './ads-campaigns.prompt'
import type {
  AdsCampaign,
  AdsPlatform,
  AdsObjective,
  AdsStatus,
  AdCopy,
} from './ads-campaigns.types'

interface GenerateInput {
  orgId:     string
  userId:    string
  productId: string
  platform:  AdsPlatform
  objective: AdsObjective
}

@Injectable()
export class AdsCampaignsService {
  private readonly logger = new Logger(AdsCampaignsService.name)

  constructor(
    private readonly llm:     LlmService,
    private readonly metaAds: MetaAdsService,
  ) {}

  // ─────────────────────────────────────────────────────────────────
  // GERAÇÃO COM IA
  // ─────────────────────────────────────────────────────────────────

  async generateForProduct(input: GenerateInput): Promise<{
    campaign: AdsCampaign
    cost_usd: number
  }> {
    const product = await this.fetchProduct(input.productId, input.orgId)

    const { systemPrompt, userPrompt } = buildAdsCampaignPrompt(
      product,
      input.platform,
      input.objective,
    )

    const out = await this.llm.generateText({
      orgId:        input.orgId,
      feature:      'ads_campaign_gen',
      systemPrompt,
      userPrompt,
      maxTokens:    2000,
      temperature:  0.5,
      jsonMode:     true,
    })

    let parsed: {
      campaign_name?:               string
      targeting?:                   Record<string, unknown>
      budget_suggestion?:           { daily_brl?: number; total_brl?: number; duration_days?: number; bid_strategy?: string; rationale?: string }
      ad_copies?:                   AdCopy[]
      utm_params?:                  Record<string, string>
      destination_url_suggestion?:  string | null
      estimated_results?:           Record<string, number>
    }
    try {
      parsed = JSON.parse(out.text)
    } catch {
      throw new BadRequestException('IA retornou JSON inválido — tente novamente')
    }

    const dailyBrl = parsed.budget_suggestion?.daily_brl ?? 30
    if (dailyBrl <= 0) {
      throw new BadRequestException('IA sugeriu orçamento inválido')
    }

    const { data, error } = await supabaseAdmin
      .from('ads_campaigns')
      .insert({
        organization_id:  input.orgId,
        product_id:       input.productId,
        user_id:          input.userId,
        platform:         input.platform,
        name:             parsed.campaign_name ?? `${product.name.slice(0, 40)}-${input.platform}-${new Date().toISOString().slice(0, 7)}`,
        objective:        input.objective,
        targeting:        parsed.targeting ?? {},
        budget_daily_brl: dailyBrl,
        budget_total_brl: parsed.budget_suggestion?.total_brl ?? dailyBrl * 7,
        duration_days:    parsed.budget_suggestion?.duration_days ?? 7,
        bid_strategy:     parsed.budget_suggestion?.bid_strategy ?? 'lowest_cost',
        ad_copies:        parsed.ad_copies ?? [],
        utm_params:       parsed.utm_params ?? {},
        destination_url:  parsed.destination_url_suggestion ?? null,
        status:           'draft' as AdsStatus,
        generation_metadata: {
          provider:         'anthropic',
          model:            'claude-sonnet-4-6',
          cost_usd:         out.costUsd,
          rationale:        parsed.budget_suggestion?.rationale ?? null,
          estimated_results: parsed.estimated_results ?? null,
        },
      })
      .select('*')
      .maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao salvar: ${error?.message ?? 'sem dados'}`)

    return { campaign: data as AdsCampaign, cost_usd: out.costUsd }
  }

  /** Regenera somente os copies (mantém targeting/budget). */
  async regenerateCopies(id: string, orgId: string, instruction: string): Promise<{
    campaign: AdsCampaign
    cost_usd: number
  }> {
    const campaign = await this.get(id, orgId)
    if (campaign.status !== 'draft' && campaign.status !== 'ready' && campaign.status !== 'paused') {
      throw new BadRequestException(`Não pode regenerar copies em status '${campaign.status}'`)
    }

    let product
    if (campaign.product_id) {
      product = await this.fetchProduct(campaign.product_id, orgId)
    } else {
      throw new BadRequestException('Campanha sem produto vinculado — não é possível regenerar')
    }

    const { systemPrompt, userPrompt } = buildRegenerateCopiesPrompt(
      product,
      campaign.platform,
      campaign.ad_copies.map(c => ({
        variant:      c.variant,
        headline:     c.headline,
        primary_text: c.primary_text,
      })),
      instruction,
    )

    const out = await this.llm.generateText({
      orgId,
      feature:      'ads_campaign_gen',
      systemPrompt,
      userPrompt,
      maxTokens:    1200,
      temperature:  0.6,
      jsonMode:     true,
    })

    let parsed: { ad_copies?: AdCopy[] }
    try {
      parsed = JSON.parse(out.text)
    } catch {
      throw new BadRequestException('IA retornou JSON inválido')
    }
    if (!parsed.ad_copies?.length) {
      throw new BadRequestException('IA não retornou copies')
    }

    const updated = await this.update(id, orgId, { ad_copies: parsed.ad_copies })
    return { campaign: updated, cost_usd: out.costUsd }
  }

  /** Adiciona uma nova variante (A/B/C) sem regenerar as existentes. */
  async addVariant(id: string, orgId: string, variantLabel?: string): Promise<{
    campaign: AdsCampaign
    cost_usd: number
  }> {
    const campaign = await this.get(id, orgId)
    if (!campaign.product_id) throw new BadRequestException('Sem produto vinculado')

    const product = await this.fetchProduct(campaign.product_id, orgId)
    const used = new Set(campaign.ad_copies.map(c => c.variant))
    const candidates = ['A', 'B', 'C', 'D', 'E']
    const newVariant = variantLabel || candidates.find(v => !used.has(v)) || `V${campaign.ad_copies.length + 1}`

    const { systemPrompt, userPrompt } = buildRegenerateCopiesPrompt(
      product,
      campaign.platform,
      campaign.ad_copies.map(c => ({
        variant:      c.variant,
        headline:     c.headline,
        primary_text: c.primary_text,
      })),
      `Crie SOMENTE uma nova variante com label "${newVariant}" diferente das anteriores em ângulo. Retorne array com a única nova variante.`,
    )

    const out = await this.llm.generateText({
      orgId,
      feature:      'ads_campaign_gen',
      systemPrompt,
      userPrompt,
      maxTokens:    600,
      temperature:  0.7,
      jsonMode:     true,
    })

    let parsed: { ad_copies?: AdCopy[] }
    try { parsed = JSON.parse(out.text) }
    catch { throw new BadRequestException('IA retornou JSON inválido') }

    const newCopy = parsed.ad_copies?.[0]
    if (!newCopy) throw new BadRequestException('IA não retornou variante')
    newCopy.variant = newVariant   // garante label correto

    const updated = await this.update(id, orgId, {
      ad_copies: [...campaign.ad_copies, newCopy],
    })
    return { campaign: updated, cost_usd: out.costUsd }
  }

  // ─────────────────────────────────────────────────────────────────
  // CRUD
  // ─────────────────────────────────────────────────────────────────

  async list(orgId: string, opts: {
    platform?:  AdsPlatform
    status?:    AdsStatus
    productId?: string
    limit?:     number
    offset?:    number
  } = {}): Promise<{ items: AdsCampaign[]; total: number }> {
    const limit  = Math.min(opts.limit  ?? 50, 200)
    const offset = Math.max(opts.offset ?? 0, 0)

    let q = supabaseAdmin
      .from('ads_campaigns')
      .select('*', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (opts.platform)  q = q.eq('platform',   opts.platform)
    if (opts.status)    q = q.eq('status',     opts.status)
    if (opts.productId) q = q.eq('product_id', opts.productId)

    const { data, error, count } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { items: (data ?? []) as AdsCampaign[], total: count ?? 0 }
  }

  async get(id: string, orgId: string): Promise<AdsCampaign> {
    const { data, error } = await supabaseAdmin
      .from('ads_campaigns')
      .select('*')
      .eq('id', id)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Campanha não encontrada')
    return data as AdsCampaign
  }

  /** Cria campanha manual (sem IA). User passa todos os campos. */
  async create(orgId: string, userId: string, body: {
    platform:         AdsPlatform
    name:             string
    objective:        AdsObjective
    targeting?:       Record<string, unknown>
    budget_daily_brl: number
    budget_total_brl?: number
    duration_days?:   number
    bid_strategy?:    string
    ad_copies?:       AdCopy[]
    destination_url?: string
    utm_params?:      Record<string, string>
    product_id?:      string
  }): Promise<AdsCampaign> {
    if (body.budget_daily_brl <= 0) throw new BadRequestException('budget_daily_brl deve ser > 0')
    if (!body.name?.trim())          throw new BadRequestException('name obrigatório')

    const { data, error } = await supabaseAdmin
      .from('ads_campaigns')
      .insert({
        organization_id:  orgId,
        product_id:       body.product_id ?? null,
        user_id:          userId,
        platform:         body.platform,
        name:             body.name,
        objective:        body.objective,
        targeting:        body.targeting ?? {},
        budget_daily_brl: body.budget_daily_brl,
        budget_total_brl: body.budget_total_brl ?? null,
        duration_days:    body.duration_days ?? 7,
        bid_strategy:     body.bid_strategy ?? 'lowest_cost',
        ad_copies:        body.ad_copies ?? [],
        destination_url:  body.destination_url ?? null,
        utm_params:       body.utm_params ?? {},
        status:           'draft' as AdsStatus,
      })
      .select('*')
      .maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)
    return data as AdsCampaign
  }

  async update(id: string, orgId: string, patch: Partial<AdsCampaign>): Promise<AdsCampaign> {
    const allowed: (keyof AdsCampaign)[] = [
      'name', 'objective', 'targeting', 'budget_daily_brl', 'budget_total_brl',
      'duration_days', 'bid_strategy', 'ad_copies', 'destination_url', 'utm_params',
    ]
    const safe: Record<string, unknown> = {}
    for (const k of allowed) {
      if (k in patch) safe[k] = patch[k]
    }
    if (Object.keys(safe).length === 0) {
      throw new BadRequestException('nada pra atualizar')
    }

    const { data, error } = await supabaseAdmin
      .from('ads_campaigns')
      .update(safe)
      .eq('id', id)
      .eq('organization_id', orgId)
      .select('*')
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Campanha não encontrada')
    return data as AdsCampaign
  }

  // ─────────────────────────────────────────────────────────────────
  // STATUS LIFECYCLE
  // ─────────────────────────────────────────────────────────────────

  async pause(id: string, orgId: string): Promise<AdsCampaign> {
    return this.transition(id, orgId, 'paused', ['active', 'publishing', 'ready'])
  }

  async resume(id: string, orgId: string): Promise<AdsCampaign> {
    return this.transition(id, orgId, 'ready', ['paused'])
  }

  async archive(id: string, orgId: string): Promise<AdsCampaign> {
    const { data, error } = await supabaseAdmin
      .from('ads_campaigns')
      .update({ status: 'archived' })
      .eq('id', id)
      .eq('organization_id', orgId)
      .select('*')
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Campanha não encontrada')
    return data as AdsCampaign
  }

  /** Marca como pronta pra publicar (sem ainda mandar pra plataforma). */
  async markReady(id: string, orgId: string): Promise<AdsCampaign> {
    const c = await this.get(id, orgId)
    if (c.ad_copies.length === 0) throw new BadRequestException('Adicione ao menos 1 copy antes de marcar como pronta')
    if (!c.destination_url)       throw new BadRequestException('Defina a URL de destino antes de marcar como pronta')
    return this.transition(id, orgId, 'ready', ['draft'])
  }

  /** Publica campanha real na plataforma (Sprint 6 — Meta Ads only por
   *  enquanto). Cria Campaign+AdSet+Ad no Meta com status PAUSED, salva
   *  external_*_ids, marca status='active'. User libera no Meta UI. */
  async publish(id: string, orgId: string): Promise<AdsCampaign> {
    const c = await this.get(id, orgId)
    if (c.platform !== 'meta') {
      throw new BadRequestException(`Publicação automática para ${c.platform} ainda não está disponível — ativaremos em sprints futuras`)
    }
    if (c.ad_copies.length === 0) throw new BadRequestException('Sem copies pra publicar')
    if (!c.destination_url)       throw new BadRequestException('Sem destination_url')
    if (c.status !== 'ready' && c.status !== 'draft') {
      throw new BadRequestException(`Não pode publicar em status '${c.status}'`)
    }

    // Marca como publishing
    await this.transition(id, orgId, 'publishing', ['ready', 'draft'])

    try {
      const result = await this.metaAds.publish(orgId, c)
      const { data, error } = await supabaseAdmin
        .from('ads_campaigns')
        .update({
          status:               'active',
          external_campaign_id: result.campaign_id,
          external_adset_id:    result.adset_id,
          external_ad_ids:      result.ad_ids,
          published_at:         new Date().toISOString(),
        })
        .eq('id', id)
        .eq('organization_id', orgId)
        .select('*')
        .maybeSingle()
      if (error || !data) throw new BadRequestException(`Erro ao salvar publish: ${error?.message ?? 'sem dados'}`)
      return data as AdsCampaign
    } catch (e) {
      await supabaseAdmin
        .from('ads_campaigns')
        .update({ status: 'error' })
        .eq('id', id)
        .eq('organization_id', orgId)
      throw e
    }
  }

  /** Sync de métricas pra 1 campanha (puxa insights da plataforma). */
  async syncMetrics(id: string, orgId: string): Promise<AdsCampaign> {
    const c = await this.get(id, orgId)
    if (!c.external_campaign_id) {
      throw new BadRequestException('Campanha ainda não publicada')
    }
    if (c.platform !== 'meta') {
      throw new BadRequestException(`Sync de métricas para ${c.platform} não disponível`)
    }

    const stored = await this.metaAds.getStoredToken(orgId)
    if (!stored?.access_token) throw new BadRequestException('Meta Ads não conectado')

    const insights = await this.metaAds.fetchInsights(stored.access_token, c.external_campaign_id)

    const { data, error } = await supabaseAdmin
      .from('ads_campaigns')
      .update({ metrics: insights })
      .eq('id', id)
      .eq('organization_id', orgId)
      .select('*')
      .maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)
    return data as AdsCampaign
  }

  /** Lista campanhas active/publishing pra o worker tickar sync de métricas. */
  async listForMetricsSync(limit = 30): Promise<Array<{ id: string; organization_id: string; platform: AdsPlatform; external_campaign_id: string }>> {
    const { data, error } = await supabaseAdmin
      .from('ads_campaigns')
      .select('id, organization_id, platform, external_campaign_id')
      .in('status', ['active', 'publishing'])
      .not('external_campaign_id', 'is', null)
      .limit(limit)
    if (error) {
      this.logger.warn(`[ads.listForMetricsSync] ${error.message}`)
      return []
    }
    return (data ?? []) as Array<{ id: string; organization_id: string; platform: AdsPlatform; external_campaign_id: string }>
  }

  // ─────────────────────────────────────────────────────────────────
  // MÉTRICAS (Sprint 6 implementa sync real via APIs)
  // ─────────────────────────────────────────────────────────────────

  async getMetrics(id: string, orgId: string): Promise<{
    metrics:     Record<string, unknown>
    last_sync:   string | null
    note?:       string
  }> {
    const c = await this.get(id, orgId)
    return {
      metrics:   c.metrics,
      last_sync: (c.metrics as { last_sync?: string }).last_sync ?? null,
      note:      Object.keys(c.metrics).length === 0
        ? 'Sem métricas ainda — sync com Meta/Google Ads é Sprint 6'
        : undefined,
    }
  }

  /** Dashboard: agregados por plataforma + total. */
  async dashboard(orgId: string): Promise<{
    by_platform: Record<AdsPlatform, { count: number; spend_brl: number; conversions: number; roas_avg: number | null }>
    total:       { count: number; spend_brl: number; conversions: number }
  }> {
    const { data, error } = await supabaseAdmin
      .from('ads_campaigns')
      .select('platform, metrics, status')
      .eq('organization_id', orgId)
      .neq('status', 'archived')
    if (error) throw new BadRequestException(`Erro: ${error.message}`)

    const acc: Record<string, { count: number; spend_brl: number; conversions: number; roas_total: number; roas_n: number }> = {}
    let totalSpend = 0, totalConv = 0, totalCount = 0

    for (const row of (data ?? [])) {
      const plat = row.platform as AdsPlatform
      const m = (row.metrics ?? {}) as { spend_brl?: number; conversions?: number; roas?: number }
      if (!acc[plat]) acc[plat] = { count: 0, spend_brl: 0, conversions: 0, roas_total: 0, roas_n: 0 }
      acc[plat].count++
      acc[plat].spend_brl   += m.spend_brl   ?? 0
      acc[plat].conversions += m.conversions ?? 0
      if (m.roas != null) {
        acc[plat].roas_total += m.roas
        acc[plat].roas_n++
      }
      totalCount++
      totalSpend += m.spend_brl   ?? 0
      totalConv  += m.conversions ?? 0
    }

    const by_platform: Record<AdsPlatform, { count: number; spend_brl: number; conversions: number; roas_avg: number | null }> = {
      meta:               { count: 0, spend_brl: 0, conversions: 0, roas_avg: null },
      google:             { count: 0, spend_brl: 0, conversions: 0, roas_avg: null },
      tiktok:             { count: 0, spend_brl: 0, conversions: 0, roas_avg: null },
      mercado_livre_ads:  { count: 0, spend_brl: 0, conversions: 0, roas_avg: null },
    }
    for (const [k, v] of Object.entries(acc)) {
      const plat = k as AdsPlatform
      by_platform[plat] = {
        count:       v.count,
        spend_brl:   v.spend_brl,
        conversions: v.conversions,
        roas_avg:    v.roas_n > 0 ? v.roas_total / v.roas_n : null,
      }
    }

    return {
      by_platform,
      total: { count: totalCount, spend_brl: totalSpend, conversions: totalConv },
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────

  private async transition(
    id: string,
    orgId: string,
    to: AdsStatus,
    fromAllowed: AdsStatus[],
  ): Promise<AdsCampaign> {
    const { data, error } = await supabaseAdmin
      .from('ads_campaigns')
      .update({ status: to })
      .eq('id', id)
      .eq('organization_id', orgId)
      .in('status', fromAllowed)
      .select('*')
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) {
      throw new BadRequestException(
        `Transição inválida: '${to}' só de [${fromAllowed.join(',')}]`,
      )
    }
    return data as AdsCampaign
  }

  private async fetchProduct(productId: string, orgId: string) {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select(`
        id, name, brand, category, price,
        short_description, description,
        differentials, target_audience, ai_score
      `)
      .eq('id', productId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Produto não encontrado')
    return data as {
      id:                string
      name:              string
      brand:             string | null
      category:          string | null
      price:             number | null
      short_description: string | null
      description:       string | null
      differentials:     string[] | null
      target_audience:   string | null
      ai_score:          number | null
    }
  }
}
