import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { MessagingService } from '../messaging/messaging.service'
import { LlmService } from '../ai/llm.service'

export type CampaignStatus = 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled'
export type CampaignChannel = 'whatsapp' | 'email' | 'both'
export type CampaignSegmentType = 'all' | 'vip' | 'with_cpf' | 'custom'

export interface Campaign {
  id:               string
  organization_id:  string
  name:             string
  status:           CampaignStatus
  channel:          CampaignChannel
  segment_type:     CampaignSegmentType
  segment_filters:  Record<string, unknown> | null
  estimated_reach:  number | null
  scheduled_at:     string | null
  interval_seconds: number
  interval_jitter:  number
  daily_limit:      number
  ab_enabled:       boolean
  ab_split_pct:     number
  product_ids:      string[] | null
  template_a_id:    string | null
  template_b_id:    string | null
  total_targets:    number
  total_sent:       number
  total_delivered:  number
  total_failed:     number
  started_at:       string | null
  completed_at:     string | null
  created_by:       string | null
  created_at:       string
  updated_at:       string
}

export interface CampaignTarget {
  id:                string
  campaign_id:       string
  organization_id:   string
  customer_id:       string
  variant:           'a' | 'b'
  status:            'pending' | 'sent' | 'delivered' | 'failed' | 'skipped'
  scheduled_for:     string | null
  sent_at:           string | null
  error_message:     string | null
  messaging_send_id: string | null
  created_at:        string
}

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name)

  constructor(
    private readonly messaging: MessagingService,
    private readonly llm:       LlmService,
  ) {}

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async list(orgId: string): Promise<Campaign[]> {
    const { data, error } = await supabaseAdmin
      .from('campaigns')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    if (error) throw new BadRequestException(error.message)
    return (data ?? []) as Campaign[]
  }

  async getOne(orgId: string, id: string): Promise<Campaign> {
    const { data, error } = await supabaseAdmin
      .from('campaigns').select('*')
      .eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (error)  throw new BadRequestException(error.message)
    if (!data)  throw new NotFoundException('campanha não encontrada')
    return data as Campaign
  }

  async create(
    orgId:    string,
    userId:   string | null,
    input:    Partial<Campaign>,
  ): Promise<Campaign> {
    if (!input.name) throw new BadRequestException('name obrigatório')

    const row = {
      organization_id:  orgId,
      name:             input.name,
      status:           input.status            ?? 'draft',
      channel:          input.channel           ?? 'whatsapp',
      segment_type:     input.segment_type      ?? 'all',
      segment_filters:  input.segment_filters   ?? null,
      estimated_reach:  input.estimated_reach   ?? null,
      scheduled_at:     input.scheduled_at      ?? null,
      interval_seconds: input.interval_seconds  ?? 60,
      interval_jitter:  input.interval_jitter   ?? 30,
      daily_limit:      input.daily_limit       ?? 200,
      ab_enabled:       input.ab_enabled        ?? false,
      ab_split_pct:     input.ab_split_pct      ?? 50,
      product_ids:      input.product_ids       ?? null,
      template_a_id:    input.template_a_id     ?? null,
      template_b_id:    input.template_b_id     ?? null,
      created_by:       userId,
    }
    const { data, error } = await supabaseAdmin
      .from('campaigns').insert(row).select().single()
    if (error) throw new BadRequestException(error.message)
    return data as Campaign
  }

  async update(orgId: string, id: string, patch: Partial<Campaign>): Promise<Campaign> {
    const cur = await this.getOne(orgId, id)
    if (cur.status === 'running' || cur.status === 'completed') {
      throw new BadRequestException(`não dá pra editar campanha em status ${cur.status}`)
    }

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    const editable: (keyof Campaign)[] = [
      'name', 'channel', 'segment_type', 'segment_filters', 'estimated_reach',
      'scheduled_at', 'interval_seconds', 'interval_jitter', 'daily_limit',
      'ab_enabled', 'ab_split_pct', 'product_ids', 'template_a_id', 'template_b_id',
    ]
    for (const k of editable) {
      if (patch[k] !== undefined) update[k] = patch[k]
    }

    const { data, error } = await supabaseAdmin
      .from('campaigns').update(update)
      .eq('id', id).eq('organization_id', orgId)
      .select().single()
    if (error) throw new BadRequestException(error.message)
    return data as Campaign
  }

  async remove(orgId: string, id: string): Promise<{ ok: true }> {
    const cur = await this.getOne(orgId, id)
    if (cur.status === 'running') {
      throw new BadRequestException('pause antes de deletar')
    }
    const { error } = await supabaseAdmin
      .from('campaigns').delete()
      .eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)
    return { ok: true }
  }

  // ── Audience preview ──────────────────────────────────────────────────────

  /** Conta destinatários sem materializar — usado pelo wizard. */
  async estimateReach(
    orgId: string,
    input: { segment_type: CampaignSegmentType; segment_filters?: Record<string, unknown> | null; customer_ids?: string[] },
  ): Promise<{ reach: number }> {
    const q = this.buildSegmentQuery(
      orgId,
      input.segment_type,
      input.segment_filters ?? null,
      input.customer_ids ?? null,
      'id',
      true,
    )
    const { count, error } = await q
    if (error) throw new BadRequestException(error.message)
    return { reach: count ?? 0 }
  }

  /** Constrói o SELECT de segment (reusado por estimateReach + launch).
   * Quando `headOnly=true`, vira um count-only query (não traz rows). */
  private buildSegmentQuery(
    orgId:        string,
    segmentType:  CampaignSegmentType,
    filters:      Record<string, unknown> | null,
    customerIds:  string[] | null,
    selectCols:   string = 'id, display_name, phone, cpf, tags, last_contact_at, total_purchases',
    headOnly:     boolean = false,
  ) {
    const base = supabaseAdmin.from('unified_customers')
    let q = headOnly
      ? base.select(selectCols, { count: 'exact', head: true })
      : base.select(selectCols)
    q = q
      .eq('organization_id', orgId)
      .eq('is_deleted', false)
      .not('phone', 'is', null)

    if (segmentType === 'with_cpf') q = q.not('cpf', 'is', null)
    if (segmentType === 'vip')      q = q.contains('tags', ['vip'])
    if (segmentType === 'custom') {
      if (customerIds && customerIds.length > 0) {
        q = q.in('id', customerIds)
      } else if (filters) {
        // Filtros suportados (custom): tags[], min_purchases, max_purchases,
        // last_contact_after (ISO), last_contact_before (ISO)
        const tags = Array.isArray(filters.tags) ? filters.tags as string[] : null
        if (tags && tags.length > 0) q = q.contains('tags', tags)
        if (typeof filters.min_purchases === 'number') q = q.gte('total_purchases', filters.min_purchases)
        if (typeof filters.max_purchases === 'number') q = q.lte('total_purchases', filters.max_purchases)
        if (typeof filters.last_contact_after  === 'string') q = q.gte('last_contact_at', filters.last_contact_after)
        if (typeof filters.last_contact_before === 'string') q = q.lte('last_contact_at', filters.last_contact_before)
      }
    }
    return q
  }

  // ── Launch ────────────────────────────────────────────────────────────────

  /** Materializa campaign_targets, distribui A/B, agenda com jitter +
   * daily_limit overflow, transiciona campaign para 'running' (ou 'scheduled'
   * se scheduled_at no futuro). */
  async launch(orgId: string, id: string): Promise<{ targets: number; first_at: string | null; last_at: string | null }> {
    const c = await this.getOne(orgId, id)
    if (c.status !== 'draft' && c.status !== 'scheduled') {
      throw new BadRequestException(`não dá pra launch em status ${c.status}`)
    }
    if (!c.template_a_id) throw new BadRequestException('template_a_id obrigatório')
    if (c.ab_enabled && !c.template_b_id) throw new BadRequestException('A/B ativo exige template_b_id')

    // Fetch audience
    const q = this.buildSegmentQuery(orgId, c.segment_type, c.segment_filters, null)
    const { data: customers, error } = await q
    if (error) throw new BadRequestException(error.message)
    const list = (customers ?? []) as unknown as Array<{ id: string }>
    if (list.length === 0) throw new BadRequestException('Audiência vazia — nenhum customer encontrado')

    // Embaralha pra não enviar sempre na mesma ordem (anti-padrão de detecção)
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[list[i], list[j]] = [list[j], list[i]]
    }

    // Schedule generation
    const baseStart = c.scheduled_at ? new Date(c.scheduled_at) : new Date()
    const intervalMs = Math.max(c.interval_seconds, 1) * 1000
    const jitterMs   = Math.max(c.interval_jitter, 0)  * 1000
    const splitPct   = c.ab_enabled ? Math.max(0, Math.min(100, c.ab_split_pct ?? 50)) : 100

    const now = baseStart.getTime()
    const dayMs = 86_400_000
    const dailyLimit = Math.max(c.daily_limit, 1)

    const targets: Array<{
      campaign_id: string; organization_id: string; customer_id: string;
      variant: 'a' | 'b'; status: 'pending'; scheduled_for: string;
    }> = []

    let dayBucketStart = now            // início do "dia 0"
    let inBucket = 0
    let cursor = now

    for (let i = 0; i < list.length; i++) {
      const cust = list[i]

      // Avança pro dia seguinte se estourou o daily_limit do bucket atual
      if (inBucket >= dailyLimit) {
        dayBucketStart += dayMs
        inBucket = 0
        cursor = dayBucketStart           // reseta cursor pro início do novo dia
      }

      // Aplica intervalo + jitter (não no primeiro do bucket)
      if (inBucket > 0) {
        const jitter = jitterMs > 0 ? (Math.random() * jitterMs * 2 - jitterMs) : 0
        cursor += intervalMs + jitter
      }

      // A/B: primeiros splitPct% → variant 'a', resto → 'b'
      const variant: 'a' | 'b' = c.ab_enabled
        ? (i < Math.floor(list.length * splitPct / 100) ? 'a' : 'b')
        : 'a'

      targets.push({
        campaign_id:     c.id,
        organization_id: orgId,
        customer_id:     cust.id,
        variant,
        status:          'pending',
        scheduled_for:   new Date(cursor).toISOString(),
      })
      inBucket++
    }

    // Insere em chunks (Postgres tem limite de 1000 por insert)
    const chunkSize = 500
    for (let i = 0; i < targets.length; i += chunkSize) {
      const chunk = targets.slice(i, i + chunkSize)
      const { error: iErr } = await supabaseAdmin.from('campaign_targets').insert(chunk)
      if (iErr) throw new BadRequestException(`insert targets falhou: ${iErr.message}`)
    }

    // Atualiza campaign
    const newStatus: CampaignStatus = baseStart.getTime() > Date.now() + 60_000 ? 'scheduled' : 'running'
    const firstAt = targets[0]?.scheduled_for ?? null
    const lastAt  = targets[targets.length - 1]?.scheduled_for ?? null

    await supabaseAdmin
      .from('campaigns')
      .update({
        status:        newStatus,
        total_targets: targets.length,
        started_at:    newStatus === 'running' ? new Date().toISOString() : null,
        updated_at:    new Date().toISOString(),
      })
      .eq('id', c.id)

    this.logger.log(`[campaigns.launch] org=${orgId} id=${c.id} targets=${targets.length} first=${firstAt} last=${lastAt} ab=${c.ab_enabled}`)
    return { targets: targets.length, first_at: firstAt, last_at: lastAt }
  }

  // ── Pause / Resume ────────────────────────────────────────────────────────

  async pause(orgId: string, id: string): Promise<Campaign> {
    const c = await this.getOne(orgId, id)
    if (c.status !== 'running' && c.status !== 'scheduled') {
      throw new BadRequestException(`não dá pra pausar em status ${c.status}`)
    }
    const { data, error } = await supabaseAdmin
      .from('campaigns')
      .update({ status: 'paused', updated_at: new Date().toISOString() })
      .eq('id', id).eq('organization_id', orgId)
      .select().single()
    if (error) throw new BadRequestException(error.message)
    return data as Campaign
  }

  async resume(orgId: string, id: string): Promise<Campaign> {
    const c = await this.getOne(orgId, id)
    if (c.status !== 'paused') {
      throw new BadRequestException(`não dá pra retomar em status ${c.status}`)
    }
    // Se já passou de scheduled_at → running; senão volta ao status anterior pelo scheduled_at
    const next: CampaignStatus = c.scheduled_at && new Date(c.scheduled_at) > new Date()
      ? 'scheduled' : 'running'
    const { data, error } = await supabaseAdmin
      .from('campaigns')
      .update({
        status:     next,
        started_at: c.started_at ?? (next === 'running' ? new Date().toISOString() : null),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id).eq('organization_id', orgId)
      .select().single()
    if (error) throw new BadRequestException(error.message)
    return data as Campaign
  }

  // ── Targets ───────────────────────────────────────────────────────────────

  async listTargets(
    orgId:    string,
    id:       string,
    filters:  { status?: string; variant?: string; limit?: number; offset?: number },
  ): Promise<{ items: CampaignTarget[]; total: number; limit: number; offset: number }> {
    await this.getOne(orgId, id) // valida ownership

    let q = supabaseAdmin
      .from('campaign_targets')
      .select('*', { count: 'exact' })
      .eq('campaign_id', id)
      .order('scheduled_for', { ascending: true, nullsFirst: false })

    if (filters.status)  q = q.eq('status', filters.status)
    if (filters.variant) q = q.eq('variant', filters.variant)

    const limit  = Math.min(Math.max(filters.limit  ?? 100, 1), 500)
    const offset = Math.max(filters.offset ?? 0, 0)
    q = q.range(offset, offset + limit - 1)

    const { data, error, count } = await q
    if (error) throw new BadRequestException(error.message)
    return { items: (data ?? []) as CampaignTarget[], total: count ?? 0, limit, offset }
  }

  // ── AI content generation ─────────────────────────────────────────────────

  /** Gera 1 ou 2 variantes de copy de WhatsApp via LlmService (Sprint
   * AI-ABS-1). Provider/model vem de ai_feature_settings[campaign_copy] ou
   * do registry default. providerOverride permite o usuário escolher um
   * model específico no wizard pra essa execução só. Retorna
   * {variants: [{title, body}]}. */
  async generateContent(
    orgId: string,
    input: {
      objective:        string
      product_name?:    string
      tone?:            'amigavel' | 'profissional' | 'urgente'
      ab_variants?:     boolean
      providerOverride?: { provider: 'anthropic' | 'openai'; model: string }
    },
  ): Promise<{ variants: Array<{ title: string; body: string }> }> {
    if (!input.objective) throw new BadRequestException('objective obrigatório')

    const tone    = input.tone        ?? 'amigavel'
    const wantTwo = input.ab_variants ?? false

    const systemPrompt = `Você é um copywriter especialista em WhatsApp Marketing para e-commerce brasileiro.
Sua missão é criar mensagens curtas (max 4 frases), em português, seguindo o framework
DOR → SOLUÇÃO → BENEFÍCIO. Use emojis com moderação (max 2). Tom: ${tone}.
Sempre inclua a variável {{nome}} no início pra personalização.
NÃO use links a menos que pedido. NÃO seja genérico — seja específico ao produto/objetivo.

FORMATO DE RESPOSTA: JSON puro (sem markdown), exatamente assim:
{"variants":[{"title":"Título curto","body":"Mensagem completa..."}${wantTwo ? ',{"title":"Variante B","body":"..."}' : ''}]}`

    const userPrompt = [
      `Objetivo: ${input.objective}`,
      input.product_name ? `Produto: ${input.product_name}` : null,
      wantTwo ? 'Gere 2 variantes (A e B) com abordagens diferentes pra A/B test.' : 'Gere 1 mensagem.',
    ].filter(Boolean).join('\n')

    let result
    try {
      result = await this.llm.generateText({
        orgId,
        feature:      'campaign_copy',
        systemPrompt,
        userPrompt,
        maxTokens:    800,
        jsonMode:     true,
        override:     input.providerOverride,
      })
    } catch (e) {
      this.logger.warn(`[campaigns.generateContent] org=${orgId} llm falhou: ${(e as Error).message}`)
      throw new BadRequestException(`Falha ao chamar IA: ${(e as Error).message}`)
    }

    let parsed: { variants?: Array<{ title?: string; body?: string }> } = {}
    try {
      // Algumas respostas vêm com ```json ... ``` mesmo pedindo puro (Anthropic
      // jsonMode é hint, não obrigatório). OpenAI com response_format já vem limpo.
      const cleaned = result.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
      parsed = JSON.parse(cleaned)
    } catch {
      this.logger.warn(`[campaigns.generateContent] parse falhou: ${result.text.slice(0, 200)}`)
      throw new BadRequestException('Resposta da IA não veio em JSON válido')
    }

    const variants = (parsed.variants ?? [])
      .filter(v => v.body && v.body.trim().length > 0)
      .map(v => ({ title: (v.title ?? 'Sem título').slice(0, 80), body: v.body!.trim() }))
    if (variants.length === 0) throw new BadRequestException('IA não retornou variantes')

    this.logger.log(`[campaigns.generateContent] org=${orgId} provider=${result.provider} model=${result.model} variants=${variants.length} dur=${result.latencyMs}ms tokens=${result.inputTokens}+${result.outputTokens} fallback=${result.fallbackUsed}`)
    return { variants }
  }

  // ── Cron: processCampaignTargets ──────────────────────────────────────────

  /** A cada 5min, processa targets pending de campaigns running cujo
   * scheduled_for já passou. Cap 100 por tick pra não estourar timeout
   * (Railway HTTP 60s, mas o cron roda fora do ciclo de request — usamos
   * 100 com 600ms entre sends ≈ 60s). */
  @Cron('*/5 * * * *', { name: 'processCampaignTargets' })
  async processTick(): Promise<void> {
    await this.runOnce()
  }

  /** Idêntico ao tick, exposto pra debug via POST /campaigns/process-now. */
  async runOnce(): Promise<{ processed: number; sent: number; failed: number; campaigns_completed: number; duration_ms: number }> {
    const t0 = Date.now()
    let processed = 0, sent = 0, failed = 0, campaignsCompleted = 0

    // Busca targets pending de campaigns running
    const { data: targets, error } = await supabaseAdmin
      .from('campaign_targets')
      .select('id, campaign_id, organization_id, customer_id, variant')
      .eq('status', 'pending')
      .lte('scheduled_for', new Date().toISOString())
      .order('scheduled_for', { ascending: true })
      .limit(100)
    if (error) {
      this.logger.error(`[campaigns.cron] fetch targets falhou: ${error.message}`)
      return { processed: 0, sent: 0, failed: 0, campaigns_completed: 0, duration_ms: Date.now() - t0 }
    }
    if (!targets?.length) return { processed: 0, sent: 0, failed: 0, campaigns_completed: 0, duration_ms: Date.now() - t0 }

    // Cache de campaigns que vamos consultar (template_a/b_id + status)
    const campaignIds = [...new Set(targets.map(t => t.campaign_id as string))]
    const { data: campaignRows } = await supabaseAdmin
      .from('campaigns')
      .select('id, status, template_a_id, template_b_id')
      .in('id', campaignIds)
    const campaignMap = new Map(
      (campaignRows ?? []).map(c => [c.id as string, c as { id: string; status: CampaignStatus; template_a_id: string | null; template_b_id: string | null }]),
    )

    const touchedCampaigns = new Set<string>()

    for (const t of targets) {
      processed++
      const c = campaignMap.get(t.campaign_id as string)
      if (!c) { continue }
      // Skipa targets de campaigns que não estão running (paused/cancelled)
      if (c.status !== 'running') {
        await supabaseAdmin
          .from('campaign_targets')
          .update({ status: 'skipped', error_message: `campaign status=${c.status}` })
          .eq('id', t.id)
        continue
      }

      const tplId = (t.variant as 'a' | 'b') === 'b' ? c.template_b_id : c.template_a_id
      if (!tplId) {
        await supabaseAdmin
          .from('campaign_targets')
          .update({ status: 'failed', error_message: 'template não definido para variante' })
          .eq('id', t.id)
        failed++
        continue
      }

      try {
        const r = await this.messaging.sendOne(
          t.organization_id as string,
          t.customer_id as string,
          tplId,
        )
        await supabaseAdmin
          .from('campaign_targets')
          .update({
            status:            r.success ? 'sent' : 'failed',
            sent_at:           r.success ? new Date().toISOString() : null,
            error_message:     r.error ?? null,
            messaging_send_id: r.messaging_send_id ?? null,
          })
          .eq('id', t.id)
        if (r.success) sent++
        else           failed++

        // Bump counters na campaign
        const counterField = r.success ? 'total_sent' : 'total_failed'
        await supabaseAdmin.rpc('increment_campaign_counter', {
          p_campaign_id: t.campaign_id,
          p_field:       counterField,
        }).then(({ error: rpcErr }) => {
          if (rpcErr) {
            // Fallback: SELECT + UPDATE (se RPC não existir)
            return this.bumpCounterFallback(t.campaign_id as string, counterField)
          }
        })
      } catch (e) {
        const msg = (e as Error)?.message ?? 'erro desconhecido'
        await supabaseAdmin
          .from('campaign_targets')
          .update({ status: 'failed', error_message: msg })
          .eq('id', t.id)
        failed++
      }

      touchedCampaigns.add(t.campaign_id as string)
      // Pequeno respiro entre WA sends pra ficar abaixo do rate limit (10/s)
      await new Promise(r => setTimeout(r, 600))
    }

    // Pra cada campaign tocada, checa se todos os targets terminaram → completed
    for (const cid of touchedCampaigns) {
      const { count: pendingLeft } = await supabaseAdmin
        .from('campaign_targets')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', cid)
        .eq('status', 'pending')
      if ((pendingLeft ?? 0) === 0) {
        await supabaseAdmin
          .from('campaigns')
          .update({
            status:       'completed',
            completed_at: new Date().toISOString(),
            updated_at:   new Date().toISOString(),
          })
          .eq('id', cid)
          .in('status', ['running', 'scheduled'])
        campaignsCompleted++
      }
    }

    const duration = Date.now() - t0
    if (processed > 0) {
      this.logger.log(`[campaigns.cron] processed=${processed} sent=${sent} failed=${failed} completed=${campaignsCompleted} dur=${duration}ms`)
    }
    return { processed, sent, failed, campaigns_completed: campaignsCompleted, duration_ms: duration }
  }

  /** Fallback caso a RPC increment_campaign_counter não exista no banco. */
  private async bumpCounterFallback(campaignId: string, field: string): Promise<void> {
    const { data: row } = await supabaseAdmin
      .from('campaigns').select(field).eq('id', campaignId).maybeSingle()
    if (!row) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cur = ((row as any)[field] ?? 0) as number
    await supabaseAdmin.from('campaigns').update({ [field]: cur + 1 }).eq('id', campaignId)
  }
}
