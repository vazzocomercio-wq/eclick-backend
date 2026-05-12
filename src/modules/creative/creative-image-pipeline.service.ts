import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'
import { CreativeService, type CreativeProduct, type CreativeBriefing } from './creative.service'
import { buildImagePromptsRequest } from './creative.prompts'
import type { Marketplace } from './creative.marketplace-rules'
import {
  CreativeTemplateResolutionService,
  type ProductRow,
  type BriefingRow,
} from './creative-template-resolution.service'
import type {
  TemplatePositionDto, AspectRatio,
} from './dto/template-position.dto'
import type { CreativeImagePromptTemplate } from './creative-prompt-templates.service'

// ── Types ─────────────────────────────────────────────────────────────────

export type JobStatus =
  | 'queued'
  | 'generating_prompts'
  | 'generating_images'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type ImageStatus =
  | 'pending'
  | 'generating'
  | 'ready'
  | 'approved'
  | 'rejected'
  | 'failed'

export interface CreativeImageJob {
  id:                  string
  organization_id:     string
  product_id:          string
  briefing_id:         string
  listing_id:          string | null
  user_id:             string | null
  status:              JobStatus
  requested_count:     number
  completed_count:     number
  failed_count:        number
  approved_count:      number
  rejected_count:      number
  max_cost_usd:        number
  total_cost_usd:      number
  prompts_generated:   string[]
  prompts_metadata:    Record<string, unknown>
  error_message:       string | null
  started_at:          string | null
  completed_at:        string | null
  created_at:          string
  updated_at:          string
}

export interface CreativeImage {
  id:                   string
  job_id:               string
  product_id:           string
  organization_id:      string
  position:             number
  prompt_text:          string
  status:               ImageStatus
  storage_path:         string | null
  generation_metadata:  Record<string, unknown>
  regenerated_from_id:  string | null
  approved_at:          string | null
  approved_by:          string | null
  rejected_at:          string | null
  rejected_by:          string | null
  error_message:        string | null
  created_at:           string
  updated_at:           string
  /** Embutido pelo backend pra UI exibir sem signing extra. */
  signed_image_url?:    string | null
}

interface CreateJobDto {
  product_id:    string
  briefing_id:   string
  listing_id?:   string
  count?:        number       // override do briefing.image_count
  max_cost_usd?: number       // override do default $1
}

@Injectable()
export class CreativeImagePipelineService {
  private readonly logger = new Logger(CreativeImagePipelineService.name)
  // Lock simples in-process pra impedir 2 ticks paralelos no mesmo node
  private processing = new Set<string>()

  constructor(
    private readonly llm:        LlmService,
    private readonly creative:   CreativeService,
    private readonly resolution: CreativeTemplateResolutionService,
  ) {}

  // ════════════════════════════════════════════════════════════════════════
  // JOB CRUD
  // ════════════════════════════════════════════════════════════════════════

  async createJob(orgId: string, userId: string, dto: CreateJobDto): Promise<CreativeImageJob> {
    if (!dto.product_id)  throw new BadRequestException('product_id obrigatório')
    if (!dto.briefing_id) throw new BadRequestException('briefing_id obrigatório')

    const product  = await this.creative.getProduct(orgId, dto.product_id)
    const briefing = await this.creative.getBriefing(orgId, dto.briefing_id)
    if (briefing.product_id !== product.id) {
      throw new BadRequestException('briefing não pertence a esse produto')
    }

    const count        = clamp(dto.count ?? briefing.image_count, 1, 20)
    const maxCostUsd   = Math.max(0.01, Math.min(20, dto.max_cost_usd ?? 1.0))

    const { data, error } = await supabaseAdmin
      .from('creative_image_jobs')
      .insert({
        organization_id:  orgId,
        product_id:       product.id,
        briefing_id:      briefing.id,
        listing_id:       dto.listing_id ?? null,
        user_id:          userId,
        status:           'queued',
        requested_count:  count,
        max_cost_usd:     maxCostUsd,
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`createJob: ${error.message}`)
    this.logger.log(`[creative.image] job ${data.id} criado — count=${count} maxCost=$${maxCostUsd}`)
    return data as CreativeImageJob
  }

  async getJob(orgId: string, jobId: string): Promise<CreativeImageJob> {
    const { data, error } = await supabaseAdmin
      .from('creative_image_jobs')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', jobId)
      .maybeSingle()
    if (error) throw new BadRequestException(`getJob: ${error.message}`)
    if (!data) throw new NotFoundException('job não encontrado')
    return data as CreativeImageJob
  }

  async listJobsByProduct(orgId: string, productId: string): Promise<CreativeImageJob[]> {
    await this.creative.getProduct(orgId, productId) // tenant check
    const { data, error } = await supabaseAdmin
      .from('creative_image_jobs')
      .select('*')
      .eq('organization_id', orgId)
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw new BadRequestException(`listJobsByProduct: ${error.message}`)
    return (data ?? []) as CreativeImageJob[]
  }

  async listImagesByJob(orgId: string, jobId: string): Promise<CreativeImage[]> {
    await this.getJob(orgId, jobId) // tenant check
    const { data, error } = await supabaseAdmin
      .from('creative_images')
      .select('*')
      .eq('organization_id', orgId)
      .eq('job_id', jobId)
      .order('position', { ascending: true })
    if (error) throw new BadRequestException(`listImagesByJob: ${error.message}`)
    const images = (data ?? []) as CreativeImage[]
    return Promise.all(images.map(async img => ({
      ...img,
      signed_image_url: img.storage_path
        ? await this.creative.signImage(img.storage_path, 3600).catch(() => null)
        : null,
    })))
  }

  /** Lista imagens approved/ready de um produto (todas elegiveis pra
   *  source de video). Inclui signed_image_url pra preview. */
  async listImagesByProduct(orgId: string, productId: string): Promise<CreativeImage[]> {
    await this.creative.getProduct(orgId, productId) // tenant check
    const { data, error } = await supabaseAdmin
      .from('creative_images')
      .select('*')
      .eq('organization_id', orgId)
      .eq('product_id', productId)
      .in('status', ['ready', 'approved'])
      .order('created_at', { ascending: false })
      .limit(60)
    if (error) throw new BadRequestException(`listImagesByProduct: ${error.message}`)
    const images = (data ?? []) as CreativeImage[]
    return Promise.all(images.map(async img => ({
      ...img,
      signed_image_url: img.storage_path
        ? await this.creative.signImage(img.storage_path, 3600).catch(() => null)
        : null,
    })))
  }

  async cancelJob(orgId: string, jobId: string): Promise<CreativeImageJob> {
    const job = await this.getJob(orgId, jobId)
    if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed') {
      return job
    }
    const { data, error } = await supabaseAdmin
      .from('creative_image_jobs')
      .update({ status: 'cancelled', updated_at: new Date().toISOString(), completed_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', jobId)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`cancelJob: ${error.message}`)
    return data as CreativeImageJob
  }

  // ════════════════════════════════════════════════════════════════════════
  // PER-IMAGE ACTIONS
  // ════════════════════════════════════════════════════════════════════════

  async getImage(orgId: string, imageId: string): Promise<CreativeImage> {
    const { data, error } = await supabaseAdmin
      .from('creative_images')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', imageId)
      .maybeSingle()
    if (error) throw new BadRequestException(`getImage: ${error.message}`)
    if (!data) throw new NotFoundException('imagem não encontrada')
    return data as CreativeImage
  }

  async approveImage(orgId: string, imageId: string, userId: string): Promise<CreativeImage> {
    const img = await this.getImage(orgId, imageId)
    if (img.status === 'approved') return img
    if (img.status !== 'ready' && img.status !== 'rejected') {
      throw new BadRequestException(`não pode aprovar imagem com status='${img.status}'`)
    }
    const { data, error } = await supabaseAdmin
      .from('creative_images')
      .update({
        status:      'approved',
        approved_at: new Date().toISOString(),
        approved_by: userId,
        rejected_at: null,
        rejected_by: null,
        updated_at:  new Date().toISOString(),
      })
      .eq('organization_id', orgId)
      .eq('id', imageId)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`approveImage: ${error.message}`)
    await this.recountJob(img.job_id)
    return data as CreativeImage
  }

  async rejectImage(orgId: string, imageId: string, userId: string): Promise<CreativeImage> {
    const img = await this.getImage(orgId, imageId)
    if (img.status === 'rejected') return img
    const { data, error } = await supabaseAdmin
      .from('creative_images')
      .update({
        status:      'rejected',
        rejected_at: new Date().toISOString(),
        rejected_by: userId,
        approved_at: null,
        approved_by: null,
        updated_at:  new Date().toISOString(),
      })
      .eq('organization_id', orgId)
      .eq('id', imageId)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`rejectImage: ${error.message}`)
    await this.recountJob(img.job_id)
    return data as CreativeImage
  }

  /** Bulk regenerate: cria 1 nova imagem `pending` por imagem rejeitada do job.
   *  Reusa o prompt original. Respeita cost cap (rejeita se já estourou).
   *  Re-coloca o job em generating_images pra worker pegar. */
  async regenerateAllRejected(orgId: string, jobId: string): Promise<{ regenerated: number; skipped_cost_cap: boolean }> {
    const job = await this.getJob(orgId, jobId)
    if (job.total_cost_usd >= job.max_cost_usd) {
      return { regenerated: 0, skipped_cost_cap: true }
    }

    const { data: rejected, error } = await supabaseAdmin
      .from('creative_images')
      .select('id, position, prompt_text, product_id')
      .eq('organization_id', orgId)
      .eq('job_id', jobId)
      .eq('status', 'rejected')
    if (error) throw new BadRequestException(`regenerateAllRejected.list: ${error.message}`)
    if (!rejected || rejected.length === 0) return { regenerated: 0, skipped_cost_cap: false }

    const rows = (rejected as Array<{ id: string; position: number; prompt_text: string; product_id: string }>).map(r => ({
      job_id:              jobId,
      product_id:          r.product_id,
      organization_id:     orgId,
      position:            r.position,
      prompt_text:         r.prompt_text,
      status:              'pending' as const,
      regenerated_from_id: r.id,
    }))

    const { error: insertErr } = await supabaseAdmin.from('creative_images').insert(rows)
    if (insertErr) throw new BadRequestException(`regenerateAllRejected.insert: ${insertErr.message}`)

    // Re-coloca job em generating_images se não estiver
    await supabaseAdmin
      .from('creative_image_jobs')
      .update({ status: 'generating_images', completed_at: null, updated_at: new Date().toISOString() })
      .eq('id', jobId)
      .in('status', ['completed', 'generating_images', 'failed'])

    return { regenerated: rows.length, skipped_cost_cap: false }
  }

  /** Cria nova imagem na mesma posição com regenerated_from_id apontando pra
   *  original. Worker pega na próxima tick. */
  async regenerateImage(orgId: string, imageId: string, customPrompt?: string): Promise<CreativeImage> {
    const original = await this.getImage(orgId, imageId)
    const job = await this.getJob(orgId, original.job_id)
    if (job.total_cost_usd >= job.max_cost_usd) {
      throw new BadRequestException('limite de custo do job atingido — crie um novo job')
    }

    const { data, error } = await supabaseAdmin
      .from('creative_images')
      .insert({
        job_id:              original.job_id,
        product_id:          original.product_id,
        organization_id:     orgId,
        position:            original.position,
        prompt_text:         customPrompt?.trim() || original.prompt_text,
        status:              'pending',
        regenerated_from_id: original.id,
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`regenerateImage.insert: ${error.message}`)

    // Re-coloca o job em 'generating_images' pra worker pegar
    await supabaseAdmin
      .from('creative_image_jobs')
      .update({ status: 'generating_images', updated_at: new Date().toISOString(), completed_at: null })
      .eq('id', original.job_id)
      .in('status', ['completed', 'generating_images', 'failed'])

    return data as CreativeImage
  }

  // ════════════════════════════════════════════════════════════════════════
  // WORKER PIPELINE
  // ════════════════════════════════════════════════════════════════════════

  /** Atomicamente reivindica o próximo job 'queued'. Retorna null se não há.
   *  Single-worker assumido — race tolerável com `eq('status','queued')` no UPDATE. */
  async claimNextJob(): Promise<CreativeImageJob | null> {
    const { data: queued } = await supabaseAdmin
      .from('creative_image_jobs')
      .select('id')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (!queued) return null

    const { data: claimed, error } = await supabaseAdmin
      .from('creative_image_jobs')
      .update({
        status:     'generating_prompts',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', (queued as { id: string }).id)
      .eq('status', 'queued')
      .select('*')
      .maybeSingle()
    if (error) {
      this.logger.warn(`[claimNextJob] update falhou: ${error.message}`)
      return null
    }
    return claimed as CreativeImageJob | null
  }

  /** Pipeline completo: prompts → N imagens → status final.
   *  Idempotente quanto a status — só processa o que estiver pendente. */
  async processJob(jobId: string): Promise<void> {
    if (this.processing.has(jobId)) return
    this.processing.add(jobId)
    try {
      const job = await this.getJobById(jobId)
      if (!job) return
      if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed') return

      // Etapa 1: gerar prompts (se ainda não gerados)
      if (!job.prompts_generated || job.prompts_generated.length === 0) {
        await this.generatePrompts(job)
      }

      // Etapa 2: gerar imagens pendentes
      await this.generatePendingImages(jobId)

      // Etapa 3: finalizar status
      await this.finalizeJob(jobId)
    } catch (e: unknown) {
      this.logger.error(`[processJob ${jobId}] ${(e as Error).message}`)
      await this.markJobFailed(jobId, (e as Error).message)
    } finally {
      this.processing.delete(jobId)
    }
  }

  private async getJobById(jobId: string): Promise<CreativeImageJob | null> {
    const { data } = await supabaseAdmin
      .from('creative_image_jobs')
      .select('*')
      .eq('id', jobId)
      .maybeSingle()
    return (data as CreativeImageJob) ?? null
  }

  /**
   * F6 Sprint 2.3 — Pipeline template-driven com fallback LLM.
   *
   * Ordem de tentativa:
   *   1. `matchTemplateForProduct` → se org tem template (default, por categoria
   *      ou most_recent), usa `buildPromptsFromTemplate` (rich metadata,
   *      refs por position resolvidas e persistidas como paths).
   *   2. Senão (org sem nenhum template), fallback pro fluxo antigo —
   *      `buildPromptsFromLlm` que reusa briefing.image_prompts OR Sonnet on-demand.
   *
   * `creative_image_jobs.prompts_metadata.source` indica qual caminho rodou.
   * Cada `creative_images.generation_metadata.source` também marca o caminho.
   */
  private async generatePrompts(job: CreativeImageJob): Promise<void> {
    const product  = await this.creative.getProduct(job.organization_id, job.product_id)
    const briefing = await this.creative.getBriefing(job.organization_id, job.briefing_id)

    await supabaseAdmin
      .from('creative_image_jobs')
      .update({ status: 'generating_prompts', updated_at: new Date().toISOString() })
      .eq('id', job.id)

    // 1. Tenta template-driven
    let rowsToInsert: Array<{ prompt_text: string; generation_metadata: Record<string, unknown> }> | null = null
    let promptsMetadata: Record<string, unknown> = {}
    let promptsCostUsd = 0

    const matched = await this.resolution.matchTemplateForProduct(job.organization_id, job.product_id)
    if (matched && matched.template.positions.length > 0) {
      this.logger.log(
        `[creative.image] job ${job.id} usando template "${matched.template.name}" ` +
        `(reason=${matched.match_reason})`,
      )
      rowsToInsert = await this.buildPromptsFromTemplate(
        matched.template,
        product,
        briefing,
        job.requested_count,
      )
      promptsMetadata = {
        source: 'template',
        template: {
          template_id:   matched.template.id,
          template_name: matched.template.name,
          match_reason:  matched.match_reason,
          matched_category_ml_id: matched.matched_category_ml_id ?? null,
          positions_in_template:  matched.template.positions.length,
          positions_used:         rowsToInsert.length,
        },
        generated_at: new Date().toISOString(),
      }
    }

    // 2. Fallback LLM (org sem template ou template vazio)
    if (!rowsToInsert) {
      const fallback = await this.buildPromptsFromLlm(job, product, briefing, job.requested_count)
      rowsToInsert    = fallback.rows
      promptsMetadata = fallback.metadata
      promptsCostUsd  = fallback.costUsd
    }

    if (rowsToInsert.length === 0) {
      throw new Error('Nenhum prompt válido (template sem positions + LLM falhou)')
    }

    // Insere creative_images por prompt
    const rows = rowsToInsert.map((d, i) => ({
      job_id:              job.id,
      product_id:          job.product_id,
      organization_id:     job.organization_id,
      position:            i + 1,
      prompt_text:         d.prompt_text,
      generation_metadata: d.generation_metadata,
      status:              'pending' as const,
    }))
    const { error: insertErr } = await supabaseAdmin.from('creative_images').insert(rows)
    if (insertErr) throw new Error(`creative_images.insert: ${insertErr.message}`)

    // Atualiza job
    await supabaseAdmin
      .from('creative_image_jobs')
      .update({
        status:            'generating_images',
        prompts_generated: rowsToInsert.map(r => r.prompt_text),
        prompts_metadata:  promptsMetadata,
        total_cost_usd:    promptsCostUsd,
        updated_at:        new Date().toISOString(),
      })
      .eq('id', job.id)

    this.logger.log(
      `[creative.image] job ${job.id} prompts: ${rowsToInsert.length} gerados — ` +
      `source=${promptsMetadata.source} cost=$${promptsCostUsd}`,
    )
  }

  /**
   * Constrói prompts a partir de um template. Cada position vira 1 row com:
   *   - prompt_text: prompt interpolado + negative prompt anexado como "Avoid: ..."
   *   - generation_metadata.references: array de { storage_bucket, storage_path }
   *     prontas pra generateOneImage assinar JIT
   *
   * Se template tem menos positions que count, gera só as disponíveis (log warning).
   */
  private async buildPromptsFromTemplate(
    template: CreativeImagePromptTemplate,
    product: CreativeProduct,
    briefing: CreativeBriefing,
    count: number,
  ): Promise<Array<{ prompt_text: string; generation_metadata: Record<string, unknown> }>> {
    // Ordena por position asc, pega N primeiras
    const positions: TemplatePositionDto[] = [...template.positions]
      .sort((a, b) => a.position - b.position)
      .slice(0, count)

    if (positions.length < count) {
      this.logger.warn(
        `[creative.image] template "${template.name}" tem ${template.positions.length} positions; ` +
        `pedido ${count}. Vai gerar apenas ${positions.length}.`,
      )
    }

    // Adapta produto e briefing pros tipos do resolution (compatíveis por estrutura)
    const productRow:  ProductRow  = product  as unknown as ProductRow
    const briefingRow: BriefingRow = briefing as unknown as BriefingRow

    // Pré-carrega mapa value→label dos ambientes (1 query pra todas as positions)
    const ambientLabels = await this.resolution.loadAmbientLabels(productRow.organization_id)

    return Promise.all(positions.map(async pos => {
      const vars = this.resolution.buildVariables(productRow, briefingRow, pos, ambientLabels)
      const promptInterpolated = this.resolution.interpolate(pos.prompt_template, vars)
      const negativeInterpolated = pos.negative_prompt
        ? this.resolution.interpolate(pos.negative_prompt, vars)
        : null
      const finalPrompt = negativeInterpolated
        ? `${promptInterpolated}\n\nAvoid: ${negativeInterpolated}`
        : promptInterpolated

      // Resolve refs em modo path (não assina — pipeline assina JIT)
      const { refs, warnings } = await this.resolution.resolveReferencesForPosition(
        template.organization_id,
        productRow,
        briefingRow,
        pos,
        { returnPaths: true },
      )

      const aspect_ratio: AspectRatio = pos.aspect_ratio ?? '1:1'

      return {
        prompt_text: finalPrompt,
        generation_metadata: {
          source: 'template',
          template_id:        template.id,
          template_position:  pos.position,
          position_name:      pos.name,
          negative_prompt:    pos.negative_prompt ?? null,
          aspect_ratio,
          references: refs.map(r => ({
            mode:            'path',
            source:          r.source,
            storage_bucket:  r.storage_bucket,
            storage_path:    r.storage_path,
            reference_id:    r.reference_id,
            name:            r.name,
          })),
          variables_resolved: vars,
          warnings,
        },
      }
    }))
  }

  /**
   * Fallback do fluxo Sprint 1: reusa briefing.image_prompts ou gera N prompts
   * via LlmService (Claude Sonnet) on-demand. Lógica idêntica ao código anterior;
   * isolada em método separado pra clareza do pipeline.
   */
  private async buildPromptsFromLlm(
    job: CreativeImageJob,
    product: CreativeProduct,
    briefing: CreativeBriefing,
    count: number,
  ): Promise<{
    rows:     Array<{ prompt_text: string; generation_metadata: Record<string, unknown> }>
    metadata: Record<string, unknown>
    costUsd:  number
  }> {
    const baseImagePrompts = briefing.image_prompts ?? []
    let prompts: string[] = []
    let metadata: Record<string, unknown>
    let costUsd = 0

    if (baseImagePrompts.length > 0) {
      // Round-robin se base < requested
      prompts = Array.from({ length: count }, (_, i) => baseImagePrompts[i % baseImagePrompts.length])
      metadata = {
        source:       'llm_fallback',
        fallback_via: 'briefing.image_prompts',
        base_count:   baseImagePrompts.length,
        generated_at: new Date().toISOString(),
      }
    } else {
      const out = await this.llm.generateText({
        orgId:      job.organization_id,
        feature:    'creative_image_prompts',
        userPrompt: buildImagePromptsRequest({
          product: {
            name:            product.name,
            category:        product.category,
            brand:           product.brand,
            color:           product.color,
            material:        product.material,
            dimensions:      product.dimensions,
            differentials:   product.differentials,
            target_audience: product.target_audience,
            ai_analysis:     product.ai_analysis,
          },
          briefing: {
            target_marketplace: briefing.target_marketplace as Marketplace,
            visual_style:       briefing.visual_style,
            environments:       briefing.environments ?? (briefing.environment ? [briefing.environment] : []),
            custom_environment: briefing.custom_environment,
            custom_prompt:      briefing.custom_prompt,
            background_color:   briefing.background_color,
            use_logo:           briefing.use_logo,
            communication_tone: briefing.communication_tone,
            image_count:        briefing.image_count,
          },
          count,
        }),
        jsonMode:  true,
        maxTokens: 4000,
        creative:  { productId: product.id, operation: 'prompt_generation' },
      })

      prompts = parsePromptsArray(out.text, count)
      metadata = {
        source:        'llm_fallback',
        fallback_via:  'sonnet_on_demand',
        provider:      out.provider,
        model:         out.model,
        input_tokens:  out.inputTokens,
        output_tokens: out.outputTokens,
        cost_usd:      out.costUsd,
        latency_ms:    out.latencyMs,
        generated_at:  new Date().toISOString(),
      }
      costUsd = out.costUsd
    }

    const rows = prompts.map(p => ({
      prompt_text: p,
      generation_metadata: {
        source: 'llm_fallback',
      } as Record<string, unknown>,
    }))

    return { rows, metadata, costUsd }
  }

  private async generatePendingImages(jobId: string): Promise<void> {
    // Loop sequencial — gpt-image-1 é caro+lento, paraleliza demais cobra muito
    let safetyCounter = 0
    while (safetyCounter++ < 30) {
      const job = await this.getJobById(jobId)
      if (!job) return
      if (job.status === 'cancelled' || job.status === 'failed') return
      if (job.total_cost_usd >= job.max_cost_usd) {
        this.logger.warn(`[creative.image] job ${jobId} atingiu max_cost_usd=$${job.max_cost_usd} — parando`)
        await this.markJobFailed(jobId, `Limite de custo $${job.max_cost_usd} atingido`)
        return
      }

      // Pega próxima imagem pending desse job
      const { data: nextImg } = await supabaseAdmin
        .from('creative_images')
        .select('*')
        .eq('job_id', jobId)
        .eq('status', 'pending')
        .order('position', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (!nextImg) return  // sem mais pendentes

      await this.generateOneImage(nextImg as CreativeImage)
    }
  }

  /**
   * Gera 1 imagem.
   *
   * Sprint 2.3 — lê `generation_metadata` pra decidir as fontes:
   *   - Modo template (meta.references existe): itera refs, assina JIT
   *     via signStorageUrl (cada ref tem storage_bucket + storage_path).
   *     Format vem de meta.aspect_ratio.
   *   - Modo fallback (meta.references ausente/vazia): mantém o fluxo Sprint 1
   *     — main_image + briefing.logo se aplicável. Format fixo 'square'.
   *
   * Em ambos os modos, `meta` é preservado e enriquecido com provider/model/
   * cost/latency depois da chamada da LLM.
   */
  private async generateOneImage(img: CreativeImage): Promise<void> {
    const meta: Record<string, unknown> = (img.generation_metadata ?? {}) as Record<string, unknown>
    const refs = Array.isArray(meta.references) ? meta.references as Array<Record<string, unknown>> : []
    const aspectRatio = typeof meta.aspect_ratio === 'string' ? meta.aspect_ratio : '1:1'

    await supabaseAdmin
      .from('creative_images')
      .update({ status: 'generating', updated_at: new Date().toISOString() })
      .eq('id', img.id)

    try {
      let sourceUrls: string[]

      if (refs.length > 0) {
        // Modo template: assina cada ref persistida no metadata
        sourceUrls = await Promise.all(refs.map(async r => {
          const bucket = (r.storage_bucket as 'creative' | 'creative-references') ?? 'creative'
          const path   = r.storage_path as string
          return this.resolution.signStorageUrl(bucket, path, 600)
        }))
      } else {
        // Modo fallback Sprint 1: main image + logo opcional
        const product = await this.creative.getProduct(img.organization_id, img.product_id)
        const job = await this.getJobById(img.job_id)
        const briefing = job ? await this.creative.getBriefing(img.organization_id, job.briefing_id) : null
        sourceUrls = [await this.creative.signImage(product.main_image_storage_path, 600)]
        if (briefing?.use_logo && briefing.logo_storage_path) {
          sourceUrls.push(await this.creative.signImage(briefing.logo_storage_path, 600))
        }
      }

      const out = await this.llm.generateImage({
        orgId:           img.organization_id,
        feature:         'creative_image',
        prompt:          img.prompt_text,
        sourceImageUrls: sourceUrls,
        format:          mapAspectRatioToFormat(aspectRatio),
        n:               1,
        creative:        { productId: img.product_id, imageId: img.id, operation: 'image_generation' },
      })

      const first = out.images[0]
      if (!first?.b64) throw new Error('gpt-image-1 não retornou b64')

      const buffer = Buffer.from(first.b64, 'base64')
      const storagePath = `${img.organization_id}/${img.product_id}/images/${img.id}.png`
      const { error: upErr } = await supabaseAdmin.storage
        .from('creative')
        .upload(storagePath, buffer, { contentType: 'image/png', upsert: true, cacheControl: '3600' })
      if (upErr) throw new Error(`storage.upload: ${upErr.message}`)

      // Preserva meta (template info, refs, vars) e enriquece com resultado da geração
      await supabaseAdmin
        .from('creative_images')
        .update({
          status:       'ready',
          storage_path: storagePath,
          generation_metadata: {
            ...meta,
            provider:           out.provider,
            model:              out.model,
            cost_usd:           out.costUsd,
            latency_ms:         out.latencyMs,
            fallback_used:      out.fallbackUsed,
            primary_error:      out.primaryError ?? null,
            source_image_count: sourceUrls.length,
            generated_at:       new Date().toISOString(),
          },
          error_message: null,
          updated_at:    new Date().toISOString(),
        })
        .eq('id', img.id)

      await this.bumpJobAfterImage(img.job_id, out.costUsd, true)
      this.logger.log(
        `[creative.image] img ${img.id} pos=${img.position} ✓ — ` +
        `srcs=${sourceUrls.length} ratio=${aspectRatio} cost=$${out.costUsd}`,
      )
    } catch (e: unknown) {
      // Captura mensagem mais rica quando vier de axios (extrai response.data
      // que tem o motivo real do 400 da API — OpenAI/Gemini retornam JSON detalhado).
      const err = e as { message?: string; response?: { status?: number; data?: unknown }; isAxiosError?: boolean }
      let msg = err.message ?? 'erro desconhecido'
      if (err.response?.data !== undefined) {
        const dataStr = typeof err.response.data === 'string'
          ? err.response.data
          : JSON.stringify(err.response.data)
        msg = `[${err.response.status ?? '?'}] ${msg} — ${dataStr.slice(0, 800)}`
      }
      await supabaseAdmin
        .from('creative_images')
        .update({
          status:        'failed',
          error_message: msg,
          updated_at:    new Date().toISOString(),
        })
        .eq('id', img.id)
      await this.bumpJobAfterImage(img.job_id, 0, false)
      this.logger.error(`[creative.image] img ${img.id} pos=${img.position} ✗ ${msg}`)
    }
  }

  private async bumpJobAfterImage(jobId: string, costUsd: number, ok: boolean): Promise<void> {
    // Refetch + update — race tolerável com 1 worker
    const { data } = await supabaseAdmin
      .from('creative_image_jobs')
      .select('total_cost_usd, completed_count, failed_count')
      .eq('id', jobId)
      .maybeSingle()
    if (!data) return
    const row = data as { total_cost_usd: number; completed_count: number; failed_count: number }
    await supabaseAdmin
      .from('creative_image_jobs')
      .update({
        total_cost_usd:  Number(row.total_cost_usd) + costUsd,
        completed_count: row.completed_count + (ok ? 1 : 0),
        failed_count:    row.failed_count    + (ok ? 0 : 1),
        updated_at:      new Date().toISOString(),
      })
      .eq('id', jobId)
  }

  private async finalizeJob(jobId: string): Promise<void> {
    // Conta pending restantes (caso algo dê errado, fica em failed)
    const { count: pendingCount } = await supabaseAdmin
      .from('creative_images')
      .select('id', { count: 'exact', head: true })
      .eq('job_id', jobId)
      .in('status', ['pending', 'generating'])

    if ((pendingCount ?? 0) > 0) return // ainda tem trabalho

    await supabaseAdmin
      .from('creative_image_jobs')
      .update({
        status:       'completed',
        completed_at: new Date().toISOString(),
        updated_at:   new Date().toISOString(),
      })
      .eq('id', jobId)
      .neq('status', 'cancelled')
      .neq('status', 'failed')
  }

  private async markJobFailed(jobId: string, message: string): Promise<void> {
    await supabaseAdmin
      .from('creative_image_jobs')
      .update({
        status:        'failed',
        error_message: message,
        completed_at:  new Date().toISOString(),
        updated_at:    new Date().toISOString(),
      })
      .eq('id', jobId)
  }

  /** Cleanup: marca jobs zumbis (em 'generating_*' há >jobMaxMinutes) como failed,
   *  e imagens individuais em 'generating' há >imgMaxMinutes como failed.
   *  Recupera jobs presos por crash do backend mid-execução. */
  async cleanupStale(opts: { jobMaxMinutes?: number; imgMaxMinutes?: number } = {}): Promise<{ jobsFailed: number; imagesFailed: number }> {
    const jobCutoff = new Date(Date.now() - (opts.jobMaxMinutes ?? 60) * 60 * 1000).toISOString()
    const imgCutoff = new Date(Date.now() - (opts.imgMaxMinutes ?? 30) * 60 * 1000).toISOString()

    // Imagens individuais zumbis
    const { data: imgs, error: imgErr } = await supabaseAdmin
      .from('creative_images')
      .update({
        status:        'failed',
        error_message: 'Cleanup automático — imagem ficou em generating por tempo excessivo',
        updated_at:    new Date().toISOString(),
      })
      .eq('status', 'generating')
      .lt('updated_at', imgCutoff)
      .select('id, job_id')

    if (imgErr) this.logger.warn(`[cleanup.imagesFailed] ${imgErr.message}`)
    const imagesFailed = (imgs ?? []).length

    // Bumpa failed_count nos jobs afetados
    const affectedJobIds = Array.from(new Set((imgs ?? []).map(i => (i as { job_id: string }).job_id)))
    for (const jobId of affectedJobIds) {
      const failedInJob = (imgs ?? []).filter(i => (i as { job_id: string }).job_id === jobId).length
      const { data: job } = await supabaseAdmin
        .from('creative_image_jobs')
        .select('failed_count')
        .eq('id', jobId)
        .maybeSingle()
      if (job) {
        await supabaseAdmin
          .from('creative_image_jobs')
          .update({ failed_count: (job as { failed_count: number }).failed_count + failedInJob, updated_at: new Date().toISOString() })
          .eq('id', jobId)
      }
    }

    // Jobs zumbis
    const { data: jobs, error: jobErr } = await supabaseAdmin
      .from('creative_image_jobs')
      .update({
        status:        'failed',
        error_message: 'Cleanup automático — job ficou ativo por tempo excessivo (>1h)',
        completed_at:  new Date().toISOString(),
        updated_at:    new Date().toISOString(),
      })
      .in('status', ['queued', 'generating_prompts', 'generating_images'])
      .lt('updated_at', jobCutoff)
      .select('id')

    if (jobErr) this.logger.warn(`[cleanup.jobsFailed] ${jobErr.message}`)
    const jobsFailed = (jobs ?? []).length

    if (imagesFailed > 0 || jobsFailed > 0) {
      this.logger.log(`[cleanup.images] ${jobsFailed} jobs + ${imagesFailed} imagens zumbis marcados como failed`)
    }
    return { jobsFailed, imagesFailed }
  }

  /** Re-conta approved/rejected do job (após user aprovar/rejeitar). */
  async recountJob(jobId: string): Promise<void> {
    const { data } = await supabaseAdmin
      .from('creative_images')
      .select('status')
      .eq('job_id', jobId)
    if (!data) return
    const rows = data as Array<{ status: ImageStatus }>
    const approved = rows.filter(r => r.status === 'approved').length
    const rejected = rows.filter(r => r.status === 'rejected').length
    await supabaseAdmin
      .from('creative_image_jobs')
      .update({
        approved_count: approved,
        rejected_count: rejected,
        updated_at:     new Date().toISOString(),
      })
      .eq('id', jobId)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

/**
 * Mapeia aspect ratio do template (1:1, 4:5, 16:9, 9:16) pro formato aceito
 * pelo LlmService.generateImage.
 *
 * Notas:
 *   - gpt-image-1 aceita 3 formatos: square (1024×1024), story (1024×1536),
 *     wide (1536×1024)
 *   - 4:5 e 9:16 caem ambos em 'story' (vertical próximo)
 *   - 16:9 → 'wide' (horizontal)
 *   - 1:1 ou desconhecido → 'square' (default seguro)
 */
function mapAspectRatioToFormat(aspectRatio: string): 'square' | 'story' | 'wide' {
  switch (aspectRatio) {
    case '4:5':
    case '9:16':
      return 'story'
    case '16:9':
      return 'wide'
    case '1:1':
    default:
      return 'square'
  }
}

function parsePromptsArray(text: string, expected: number): string[] {
  // Tolera markdown ```json ... ``` envolvendo o output
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
  let parsed: unknown
  try { parsed = JSON.parse(cleaned) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const prompts = parsed
    .map(p => typeof p === 'string' ? p.trim() : '')
    .filter(p => p.length > 0)
    .slice(0, expected)
  return prompts
}
