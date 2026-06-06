/** Apply Service — executa recomendacoes aprovadas no ML real.
 *
 *  Suporta:
 *   - Single: 1 recomendacao -> POST /seller-promotions/offers
 *   - Batch:  N recomendacoes em sequencia (rate limit 3 simultaneas)
 *   - Leave:  DELETE oferta existente (sair de campanha)
 *
 *  v1: PRICE_DISCOUNT eh apply-only (sem edit-recreate). DOD/LIGHTNING
 *  edit fica pra v1.1.
 *
 *  Audit log: 1 row em ml_campaign_audit_log por operacao executada.
 *  INSERT-only — nunca UPDATE/DELETE pra preservar historico.
 *
 *  Rate limit: pool de 3 ofertas em paralelo (com 200ms entre starts)
 *  pra nao trigger 429 do ML. Backoff exponencial ja vem do API client.
 */

import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import { ActiveBridgeClient } from '../active-bridge/active-bridge.client'
import { ActiveResolverService } from '../active-bridge/active-resolver.service'
import { MlCampaignsApiClient, CampaignsRateLimitedException } from './ml-campaigns-api.client'
import { MlCampaignsValidatorService, ValidationResult } from './ml-campaigns-validator.service'

export interface ApplyJobInput {
  orgId:              string
  sellerId:           number
  userId:             string
  recommendationIds:  string[]
  applyMode:          'safe' | 'best_effort'
}

export interface ApplyResult {
  job_id:           string
  status:           string
  total_count:      number
  applied_count:    number
  failed_count:     number
  skipped_count:    number
  results:          Array<{
    recommendation_id: string
    status:            'applied' | 'failed' | 'skipped'
    item_id?:          string
    new_offer_id?:     string
    error_code?:       string
    error_message?:    string
  }>
}

@Injectable()
export class MlCampaignsApplyService {
  private readonly logger = new Logger(MlCampaignsApplyService.name)

  constructor(
    private readonly ml:             MercadolivreService,
    private readonly client:         MlCampaignsApiClient,
    private readonly validator:      MlCampaignsValidatorService,
    private readonly activeBridge:   ActiveBridgeClient,
    private readonly activeResolver: ActiveResolverService,
  ) {}

  // ── Apply em lote ────────────────────────────────────────────────

  async applyBatch(input: ApplyJobInput): Promise<ApplyResult> {
    if (input.recommendationIds.length === 0) {
      throw new BadRequestException('Nenhuma recomendacao selecionada')
    }

    // 1. Cria job
    const { data: jobRow, error: jobErr } = await supabaseAdmin
      .from('ml_campaign_apply_jobs')
      .insert({
        organization_id:   input.orgId,
        seller_id:         input.sellerId,
        user_id:           input.userId,
        job_type:          input.recommendationIds.length === 1 ? 'apply_single' : 'apply_batch',
        default_operation: 'POST',
        recommendation_ids: input.recommendationIds,
        apply_mode:        input.applyMode,
        total_count:       input.recommendationIds.length,
        status:            'validating',
        started_at:        new Date().toISOString(),
      })
      .select('id')
      .single()
    if (jobErr || !jobRow) throw new BadRequestException(`falha ao criar job: ${jobErr?.message}`)
    const jobId = (jobRow as { id: string }).id

    // 2. Valida tudo primeiro
    const validations = await this.validator.validateMany(input.orgId, input.recommendationIds)
    const invalid = validations.filter(v => !v.is_valid)

    await supabaseAdmin
      .from('ml_campaign_apply_jobs')
      .update({
        validated_count: validations.length,
        skipped_count:   invalid.length,
      })
      .eq('id', jobId)

    if (input.applyMode === 'safe' && invalid.length > 0) {
      await supabaseAdmin
        .from('ml_campaign_apply_jobs')
        .update({
          status:       'failed',
          completed_at: new Date().toISOString(),
          results:      validations.map(v => ({
            recommendation_id: v.recommendation_id,
            status:            v.is_valid ? 'skipped' : 'failed',
            error_code:        v.errors[0]?.code,
            error_message:     v.errors.map(e => e.message).join('; '),
          })) as unknown,
        })
        .eq('id', jobId)
      return {
        job_id:        jobId,
        status:        'failed',
        total_count:   input.recommendationIds.length,
        applied_count: 0,
        failed_count:  invalid.length,
        skipped_count: validations.length - invalid.length,
        results:       validations.map(v => ({
          recommendation_id: v.recommendation_id,
          status:            (v.is_valid ? 'skipped' : 'failed') as 'skipped' | 'failed',
          error_code:        v.errors[0]?.code,
          error_message:     v.errors.map(e => e.message).join('; '),
        })),
      }
    }

    // 3. Aplica os validos (best_effort: ignora invalidos, segue)
    await supabaseAdmin
      .from('ml_campaign_apply_jobs')
      .update({ status: 'applying' })
      .eq('id', jobId)

    const tokenRes = await this.ml.getTokenForOrg(input.orgId, input.sellerId)
    const token = tokenRes.token

    const results: ApplyResult['results'] = []
    let applied = 0, failed = 0, skipped = 0

    // Pool de 3 simultaneas (mas com 200ms entre starts pra nao trigger 429)
    const POOL = 3
    for (let i = 0; i < validations.length; i += POOL) {
      const batch = validations.slice(i, i + POOL)
      const batchResults = await Promise.all(
        batch.map(async (v, idx) => {
          // Stagger 200ms entre starts dentro do batch
          if (idx > 0) await this.sleep(200 * idx)
          if (!v.is_valid) {
            // best_effort: pula invalidos
            return {
              recommendation_id: v.recommendation_id,
              status:            'skipped' as const,
              error_code:        v.errors[0]?.code,
              error_message:     v.errors.map(e => e.message).join('; '),
            }
          }
          return this.applyOne(input.orgId, input.sellerId, input.userId, v, token, jobId)
        }),
      )
      for (const r of batchResults) {
        results.push(r)
        if      (r.status === 'applied') applied++
        else if (r.status === 'failed')  failed++
        else                              skipped++
      }
      // Update job em real-time
      await supabaseAdmin
        .from('ml_campaign_apply_jobs')
        .update({ applied_count: applied, failed_count: failed, skipped_count: skipped })
        .eq('id', jobId)
    }

    // 4. Finaliza
    const finalStatus = failed === 0 ? 'completed' : (applied > 0 ? 'partial' : 'failed')
    await supabaseAdmin
      .from('ml_campaign_apply_jobs')
      .update({
        status:        finalStatus,
        applied_count: applied,
        failed_count:  failed,
        skipped_count: skipped,
        results:       results as unknown,
        completed_at:  new Date().toISOString(),
      })
      .eq('id', jobId)

    return {
      job_id:        jobId,
      status:        finalStatus,
      total_count:   input.recommendationIds.length,
      applied_count: applied,
      failed_count:  failed,
      skipped_count: skipped,
      results,
    }
  }

  /** Apply single — wrapper de applyBatch com 1 ID. */
  async applySingle(input: Omit<ApplyJobInput, 'recommendationIds'> & { recommendationId: string }): Promise<ApplyResult> {
    return this.applyBatch({ ...input, recommendationIds: [input.recommendationId] })
  }

  // ── Single offer apply ──────────────────────────────────────────

  private async applyOne(
    orgId:    string,
    sellerId: number,
    userId:   string,
    v:       ValidationResult,
    token:   string,
    jobId:   string,
  ): Promise<ApplyResult['results'][number]> {
    // Carrega rec completa pra montar payload
    const { data: rec } = await supabaseAdmin
      .from('ml_campaign_recommendations')
      .select(`
        *,
        ml_campaign_items!inner (
          ml_item_id, ml_campaign_id, ml_promotion_type, ml_offer_id,
          original_price, current_price, campaign_id, product_id
        )
      `)
      .eq('id', v.recommendation_id)
      .maybeSingle()
    if (!rec) {
      return { recommendation_id: v.recommendation_id, status: 'failed', error_code: 'rec_not_found', error_message: 'Recomendação sumiu antes do apply' }
    }

    const r = rec as any
    const item = r.ml_campaign_items

    // Monta payload ML
    const payload = this.buildPayload(r, item)

    let response: any = null
    let success = false
    let errorCode: string | undefined
    let errorMessage: string | undefined
    let mlStatus: number | undefined
    let newOfferId: string | undefined

    try {
      response = await this.client.createOffer(token, sellerId, payload)
      success  = true
      mlStatus = 200
      newOfferId = (response.id ?? response.offer_id ?? '') || undefined
    } catch (e) {
      const err = e as { message?: string; status?: number; response?: { data?: { code?: string; message?: string }; status?: number } }
      mlStatus     = err.response?.status ?? err.status ?? 500
      errorCode    = err.response?.data?.code ?? 'ml_error'
      errorMessage = err.response?.data?.message ?? err.message ?? 'Erro desconhecido'
      response     = { error: errorMessage }
      this.logger.warn(`[apply] ${item.ml_item_id} falhou ${mlStatus}: ${errorMessage}`)

      if (e instanceof CampaignsRateLimitedException) {
        // Rate limit — propaga pra parar o job
        throw e
      }
    }

    // Audit log (sempre — sucesso ou falha)
    await supabaseAdmin
      .from('ml_campaign_audit_log')
      .insert({
        organization_id:    orgId,
        seller_id:          sellerId,
        job_id:             jobId,
        recommendation_id:  v.recommendation_id,
        campaign_id:        item.campaign_id,
        product_id:         item.product_id ?? null,
        user_id:            userId,
        ml_item_id:         item.ml_item_id,
        ml_campaign_id:     item.ml_campaign_id,
        ml_promotion_type:  item.ml_promotion_type,
        ml_offer_id_before: item.ml_offer_id ?? null,
        ml_offer_id_after:  newOfferId ?? null,
        operation:          'POST',
        action:             'join_campaign',
        values_before: {
          price:    item.current_price,
          original: item.original_price,
          status:   'candidate',
        },
        values_after: {
          price:    r.recommended_price,
          quantity: r.recommended_quantity,
          strategy: r.recommended_strategy,
        },
        ml_payload:           payload,
        ml_response:          response,
        ml_response_status:   mlStatus,
        applied_successfully: success,
        error_code:           errorCode ?? null,
        error_message:        errorMessage ?? null,
      })

    if (success) {
      // Marca recomendacao como applied
      await supabaseAdmin
        .from('ml_campaign_recommendations')
        .update({ status: 'applied' })
        .eq('id', v.recommendation_id)

      // Atualiza item local: vira started + pega offer_id
      await supabaseAdmin
        .from('ml_campaign_items')
        .update({
          status:        'started',
          ml_offer_id:   newOfferId,
          current_price: r.recommended_price,
        })
        .eq('id', r.campaign_item_id)

      return { recommendation_id: v.recommendation_id, status: 'applied', item_id: item.ml_item_id, new_offer_id: newOfferId }
    } else {
      return {
        recommendation_id: v.recommendation_id,
        status:            'failed',
        item_id:           item.ml_item_id,
        error_code:        errorCode,
        error_message:     errorMessage,
      }
    }
  }

  /** Monta payload ML pro POST /seller-promotions/offers conforme tipo. */
  private buildPayload(rec: any, item: any): Record<string, unknown> {
    const base: Record<string, unknown> = {
      promotion_id:   item.ml_campaign_id,
      promotion_type: item.ml_promotion_type,
      item_id:        item.ml_item_id,
      offer_price:    rec.recommended_price,
    }
    if (rec.recommended_quantity != null) {
      base.offer_quantity = rec.recommended_quantity
    }
    return base
  }

  // ── Participar direto (sem recomendação) — tela "Incluir em campanha" ────

  /**
   * Inclui um anúncio numa campanha disponível direto pela tela escopada do
   * funil (sem passar por recomendação). Resolve o item pelo
   * `ml_campaign_items.id`, calcula o preço da oferta (offer_price OU
   * discount_pct sobre o original), valida a faixa [min,max], chama o ML e —
   * em caso de sucesso — marca o item como `started` e AVANÇA o card do funil
   * "Anúncios ML" pra "Incluir ADS".
   */
  async joinListingPromotion(input: {
    orgId:          string
    userId:         string
    campaignItemId?: string
    // Caminho CRU (campanha vinda do fetch ao vivo, sem linha sincronizada):
    mlItemId?:      string
    sellerId?:      number
    mlCampaignId?:  string
    promotionType?: string
    originalPrice?: number
    productId?:     string | null
    offerPrice?:    number
    discountPct?:   number
  }): Promise<{ ok: boolean; status: 'joined'; ml_offer_id?: string; offer_price: number; item_id: string }> {
    type JoinItem = {
      id: string | null; seller_id: number; product_id: string | null; campaign_id: string | null
      ml_item_id: string; ml_campaign_id: string; ml_promotion_type: string; ml_offer_id: string | null; status: string
      original_price: number | null; current_price: number | null
      suggested_discounted_price: number | null; min_discounted_price: number | null; max_discounted_price: number | null
    }
    let item: JoinItem

    if (input.campaignItemId) {
      const { data: itemRow } = await supabaseAdmin
        .from('ml_campaign_items')
        .select('id, seller_id, product_id, campaign_id, ml_item_id, ml_campaign_id, ml_promotion_type, ml_offer_id, status, original_price, current_price, suggested_discounted_price, min_discounted_price, max_discounted_price')
        .eq('id', input.campaignItemId)
        .eq('organization_id', input.orgId)
        .maybeSingle()
      if (!itemRow) throw new NotFoundException('anúncio/campanha não encontrado')
      item = itemRow as JoinItem
    } else {
      // Caminho cru: a campanha foi listada ao vivo (não está sincronizada).
      if (!input.mlItemId || input.sellerId == null || !input.mlCampaignId || !input.promotionType) {
        throw new BadRequestException('Informe campaign_item_id OU (ml_item_id, seller_id, ml_campaign_id, promotion_type).')
      }
      const productId     = input.productId ?? await this.resolveProductIdByListing(input.orgId, input.mlItemId)
      const campaignRowId = await this.resolveCampaignRowId(input.orgId, input.sellerId, input.mlCampaignId)
      item = {
        id: null, seller_id: input.sellerId, product_id: productId, campaign_id: campaignRowId,
        ml_item_id: input.mlItemId, ml_campaign_id: input.mlCampaignId, ml_promotion_type: input.promotionType,
        ml_offer_id: null, status: 'candidate',
        original_price: input.originalPrice ?? null, current_price: null,
        suggested_discounted_price: null, min_discounted_price: null, max_discounted_price: null,
      }
    }
    if (item.status === 'started') {
      throw new BadRequestException('Este anúncio já participa desta campanha.')
    }

    // Preço da oferta: explícito, ou calculado do desconto %, ou o sugerido.
    let offerPrice = input.offerPrice
    if (offerPrice == null && input.discountPct != null && item.original_price != null) {
      offerPrice = item.original_price * (1 - input.discountPct / 100)
    }
    if (offerPrice == null) offerPrice = item.suggested_discounted_price ?? undefined
    if (offerPrice == null || !Number.isFinite(offerPrice) || offerPrice <= 0) {
      throw new BadRequestException('Informe o preço final (offer_price) ou o desconto (discount_pct).')
    }
    offerPrice = Math.round(offerPrice * 100) / 100
    if (item.min_discounted_price != null && offerPrice < item.min_discounted_price) {
      throw new BadRequestException(`Preço abaixo do mínimo da campanha (R$ ${item.min_discounted_price}).`)
    }
    if (item.max_discounted_price != null && offerPrice > item.max_discounted_price) {
      throw new BadRequestException(`Preço acima do máximo da campanha (R$ ${item.max_discounted_price}).`)
    }

    let token: string
    try {
      token = (await this.ml.getTokenForOrg(input.orgId, item.seller_id)).token
    } catch {
      throw new BadRequestException('Conecte a conta Mercado Livre desse anúncio em Configurações > Integrações.')
    }

    // ML v2: participar é POST /seller-promotions/items/:itemId com deal_price
    // (o antigo POST /offers responde 405).
    const payload: Record<string, unknown> = {
      promotion_id:   item.ml_campaign_id,
      promotion_type: item.ml_promotion_type,
      deal_price:     offerPrice,
    }

    let newOfferId: string | undefined
    let mlResponse: unknown = null
    try {
      const resp = await this.client.postItemPromotion(token, item.seller_id, item.ml_item_id, payload)
      mlResponse = resp
      newOfferId = (resp.id ?? resp.offer_id ?? '') || undefined
    } catch (e) {
      const msg = (e as Error).message
      await this.auditJoin(input, item, payload, offerPrice, false, null, mlResponse, msg)
      throw new BadRequestException(`O Mercado Livre recusou a inclusão: ${msg}`)
    }

    // Só atualiza a linha sincronizada se ela existir (caminho cru não tem).
    if (item.id) {
      await supabaseAdmin
        .from('ml_campaign_items')
        .update({ status: 'started', ml_offer_id: newOfferId, current_price: offerPrice })
        .eq('id', item.id)
    }

    await this.auditJoin(input, item, payload, offerPrice, true, newOfferId ?? null, mlResponse, null)
    await this.advanceFunnelCardToAds(input.orgId, item.product_id)

    return { ok: true, status: 'joined', ml_offer_id: newOfferId, offer_price: offerPrice, item_id: item.ml_item_id }
  }

  /** Audit best-effort do join direto (não derruba o fluxo se falhar). */
  private async auditJoin(
    input:      { orgId: string; userId: string },
    item:       { seller_id: number; campaign_id: string | null; product_id: string | null; ml_item_id: string; ml_campaign_id: string; ml_promotion_type: string; ml_offer_id: string | null; current_price: number | null; original_price: number | null },
    payload:    Record<string, unknown>,
    offerPrice: number,
    success:    boolean,
    newOfferId: string | null,
    mlResponse: unknown,
    errorMessage: string | null,
  ): Promise<void> {
    try {
      await supabaseAdmin.from('ml_campaign_audit_log').insert({
        organization_id:    input.orgId,
        seller_id:          item.seller_id,
        job_id:             null,
        recommendation_id:  null,
        campaign_id:        item.campaign_id,
        product_id:         item.product_id ?? null,
        user_id:            input.userId,
        ml_item_id:         item.ml_item_id,
        ml_campaign_id:     item.ml_campaign_id,
        ml_promotion_type:  item.ml_promotion_type,
        ml_offer_id_before: item.ml_offer_id ?? null,
        ml_offer_id_after:  newOfferId,
        operation:          'POST',
        action:             'join_campaign',
        values_before:      { price: item.current_price, original: item.original_price, status: 'candidate' },
        values_after:       { price: offerPrice, source: 'listing_join' },
        ml_payload:         payload,
        ml_response:        mlResponse as Record<string, unknown> | null,
        ml_response_status: success ? 200 : null,
        applied_successfully: success,
        error_code:         success ? null : 'ml_error',
        error_message:      errorMessage,
      })
    } catch (e) {
      this.logger.warn(`[join] audit falhou: ${(e as Error).message}`)
    }
  }

  /** Resolve o product_id interno a partir do anúncio ML (product_listings). */
  private async resolveProductIdByListing(orgId: string, mlItemId: string): Promise<string | null> {
    const { data } = await supabaseAdmin
      .from('product_listings')
      .select('product_id, products!inner(organization_id)')
      .eq('listing_id', mlItemId)
      .eq('platform', 'mercadolivre')
      .eq('products.organization_id', orgId)
      .limit(1)
      .maybeSingle()
    return (data as { product_id: string } | null)?.product_id ?? null
  }

  /** Acha a row local da campanha (ml_campaigns) por ids ML — best-effort (audit). */
  private async resolveCampaignRowId(orgId: string, sellerId: number, mlCampaignId: string): Promise<string | null> {
    const { data } = await supabaseAdmin
      .from('ml_campaigns')
      .select('id')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .eq('ml_campaign_id', mlCampaignId)
      .maybeSingle()
    return (data as { id: string } | null)?.id ?? null
  }

  /** Avança o card do funil "Anúncios ML" pra "Incluir ADS" após participar.
   *  Forward-only + idempotente (mesma semântica do sync). Best-effort. */
  private async advanceFunnelCardToAds(orgId: string, catalogProductId: string | null): Promise<void> {
    if (!catalogProductId || !this.activeBridge.isConfigured()) return
    try {
      const dealId = await this.activeResolver.findCardDealForProduct(orgId, catalogProductId)
      if (!dealId) return
      const baseUrl = (process.env.FRONTEND_PUBLIC_URL ?? 'https://eclick.app.br').replace(/\/+$/, '')
      await this.activeBridge.moveCard({
        deal_id:       dealId,
        to_stage_name: 'Incluir ADS',
        action_link:   { label: 'Gerenciar ADS', url: `${baseUrl}/dashboard/ads/mercadolivre` },
      })
      this.logger.log(`[join] card avançado pra Incluir ADS (produto=${catalogProductId})`)
    } catch (e) {
      this.logger.warn(`[join] avanço do card falhou: ${(e as Error).message}`)
    }
  }

  // ── Criar promoção PRÓPRIA (PRICE_DISCOUNT) — sem campanha do ML ──────────

  /**
   * Cria uma promoção própria do vendedor (PRICE_DISCOUNT) num anúncio — usado
   * quando não há campanha do ML disponível. O lojista define o preço com
   * desconto e a vigência; o ML valida o teto de 80%. Em sucesso, avança o
   * card do funil pra "Incluir ADS".
   */
  async createOwnPromotion(input: {
    orgId:         string
    userId:        string
    productId:     string | null
    mlItemId:      string
    sellerId:      number
    dealPrice:     number
    topDealPrice?: number
    startDate:     string
    finishDate:    string
  }): Promise<{ ok: boolean; status: 'created'; promotion_id?: string }> {
    if (!(input.dealPrice > 0) || !Number.isFinite(input.dealPrice)) {
      throw new BadRequestException('Informe um preço com desconto (deal_price) válido.')
    }
    const start  = normalizeMlDate(input.startDate, false)
    const finish = normalizeMlDate(input.finishDate, true)
    if (!start || !finish) throw new BadRequestException('Datas de início/fim inválidas.')

    let token: string
    try {
      token = (await this.ml.getTokenForOrg(input.orgId, input.sellerId)).token
    } catch {
      throw new BadRequestException('Conecte a conta Mercado Livre desse anúncio em Configurações > Integrações.')
    }

    const body: Record<string, unknown> = {
      promotion_type: 'PRICE_DISCOUNT',
      deal_price:     Math.round(input.dealPrice * 100) / 100,
      start_date:     start,
      finish_date:    finish,
    }
    if (input.topDealPrice != null && input.topDealPrice > 0) {
      body.top_deal_price = Math.round(input.topDealPrice * 100) / 100
    }

    let promotionId: string | undefined
    let resp: unknown = null
    try {
      const r = await this.client.postItemPromotion(token, input.sellerId, input.mlItemId, body)
      resp = r
      promotionId = (r.id ?? r.offer_id ?? '') || undefined
    } catch (e) {
      await this.auditOwnPromotion(input, body, null, false, (e as Error).message)
      throw new BadRequestException(`O Mercado Livre recusou a promoção: ${(e as Error).message}`)
    }

    await this.auditOwnPromotion(input, body, resp, true, null)
    await this.advanceFunnelCardToAds(input.orgId, input.productId)
    return { ok: true, status: 'created', promotion_id: promotionId }
  }

  /** Audit best-effort da promoção própria. */
  private async auditOwnPromotion(
    input:        { orgId: string; userId: string; productId: string | null; mlItemId: string; sellerId: number },
    payload:      Record<string, unknown>,
    mlResponse:   unknown,
    success:      boolean,
    errorMessage: string | null,
  ): Promise<void> {
    try {
      await supabaseAdmin.from('ml_campaign_audit_log').insert({
        organization_id:    input.orgId,
        seller_id:          input.sellerId,
        job_id:             null,
        recommendation_id:  null,
        campaign_id:        null,
        product_id:         input.productId ?? null,
        user_id:            input.userId,
        ml_item_id:         input.mlItemId,
        ml_campaign_id:     null,
        ml_promotion_type:  'PRICE_DISCOUNT',
        ml_offer_id_before: null,
        ml_offer_id_after:  null,
        operation:          'POST',
        action:             'create_own_promotion',
        values_before:      {},
        values_after:       payload,
        ml_payload:         payload,
        ml_response:        mlResponse as Record<string, unknown> | null,
        ml_response_status: success ? 200 : null,
        applied_successfully: success,
        error_code:         success ? null : 'ml_error',
        error_message:      errorMessage,
      })
    } catch (e) {
      this.logger.warn(`[create-own] audit falhou: ${(e as Error).message}`)
    }
  }

  // ── Leave (sair de campanha) ─────────────────────────────────────

  async leaveSingle(orgId: string, sellerId: number, userId: string, campaignItemId: string): Promise<{ ok: boolean; message?: string }> {
    const { data: itemRow } = await supabaseAdmin
      .from('ml_campaign_items')
      .select('id, ml_item_id, ml_campaign_id, ml_promotion_type, ml_offer_id, campaign_id, product_id, current_price')
      .eq('organization_id', orgId)
      .eq('id', campaignItemId)
      .maybeSingle()
    if (!itemRow) throw new BadRequestException('item nao encontrado')
    const item = itemRow as any

    if (!item.ml_offer_id) {
      throw new BadRequestException('Item nao tem oferta ativa pra sair')
    }

    const tokenRes = await this.ml.getTokenForOrg(orgId, sellerId)
    const token = tokenRes.token

    let success = false
    let errorMessage: string | undefined
    let mlStatus: number | undefined
    let response: any

    try {
      response = await this.client.deleteOffer(token, sellerId, item.ml_offer_id, item.ml_promotion_type)
      success  = true
      mlStatus = 200
    } catch (e) {
      const err = e as { message?: string; response?: { data?: any; status?: number } }
      mlStatus     = err.response?.status ?? 500
      errorMessage = err.response?.data?.message ?? err.message ?? 'Erro'
      response     = { error: errorMessage }
    }

    // Audit
    await supabaseAdmin
      .from('ml_campaign_audit_log')
      .insert({
        organization_id:    orgId,
        seller_id:          sellerId,
        recommendation_id:  null,
        campaign_id:        item.campaign_id,
        product_id:         item.product_id ?? null,
        user_id:            userId,
        ml_item_id:         item.ml_item_id,
        ml_campaign_id:     item.ml_campaign_id,
        ml_promotion_type:  item.ml_promotion_type,
        ml_offer_id_before: item.ml_offer_id,
        ml_offer_id_after:  null,
        operation:          'DELETE',
        action:             'leave_campaign',
        values_before:      { price: item.current_price, status: 'started' },
        values_after:       { status: 'finished' },
        ml_payload:         { offer_id: item.ml_offer_id },
        ml_response:        response,
        ml_response_status: mlStatus,
        applied_successfully: success,
        error_code:         success ? null : 'ml_error',
        error_message:      errorMessage ?? null,
      })

    if (success) {
      await supabaseAdmin
        .from('ml_campaign_items')
        .update({ status: 'finished', ml_offer_id: null })
        .eq('id', item.id)
    }

    return { ok: success, message: errorMessage }
  }

  // ── Job queries ─────────────────────────────────────────────────

  async getJob(orgId: string, jobId: string) {
    const { data, error } = await supabaseAdmin
      .from('ml_campaign_apply_jobs')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', jobId)
      .maybeSingle()
    if (error) throw new BadRequestException(`getJob: ${error.message}`)
    return data
  }

  async listJobs(orgId: string, sellerId?: number, limit = 20) {
    let q = supabaseAdmin
      .from('ml_campaign_apply_jobs')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (sellerId != null) q = q.eq('seller_id', sellerId)
    const { data, error } = await q
    if (error) throw new BadRequestException(`listJobs: ${error.message}`)
    return data ?? []
  }

  async listAuditLog(opts: { orgId: string; sellerId?: number; mlItemId?: string; campaignId?: string; limit?: number }) {
    let q = supabaseAdmin
      .from('ml_campaign_audit_log')
      .select('*')
      .eq('organization_id', opts.orgId)
      .order('applied_at', { ascending: false })
      .limit(Math.min(opts.limit ?? 100, 500))
    if (opts.sellerId   != null) q = q.eq('seller_id',     opts.sellerId)
    if (opts.mlItemId)           q = q.eq('ml_item_id',    opts.mlItemId)
    if (opts.campaignId)         q = q.eq('campaign_id',   opts.campaignId)
    const { data, error } = await q
    if (error) throw new BadRequestException(`listAuditLog: ${error.message}`)
    return data ?? []
  }

  private sleep(ms: number) {
    return new Promise<void>(r => setTimeout(r, ms))
  }
}

/** Normaliza data pro formato que o ML espera: "YYYY-MM-DDTHH:MM:SS" (sem TZ).
 *  Aceita "YYYY-MM-DD" (vira 00:00:00 no início / 23:59:59 no fim) ou ISO. */
function normalizeMlDate(input: string, isEnd: boolean): string | null {
  const s = (input ?? '').trim()
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return `${s}T${isEnd ? '23:59:59' : '00:00:00'}`
  }
  const m = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/)
  return m ? m[1] : null
}
