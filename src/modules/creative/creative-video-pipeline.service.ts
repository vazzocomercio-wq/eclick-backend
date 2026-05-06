import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'
import { CreativeService, type CreativeProduct } from './creative.service'
import { buildVideoPromptsRequest } from './creative.prompts'
import { KlingClient, type KlingModel, type KlingDuration, type KlingAspectRatio } from './kling.client'
import type { Marketplace } from './creative.marketplace-rules'

// ── Types ─────────────────────────────────────────────────────────────────

export type VideoJobStatus =
  | 'queued'
  | 'generating_prompts'
  | 'generating_videos'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type VideoStatus =
  | 'pending'
  | 'generating'
  | 'ready'
  | 'approved'
  | 'rejected'
  | 'failed'

export interface CreativeVideoJob {
  id:                  string
  organization_id:     string
  product_id:          string
  briefing_id:         string
  listing_id:          string | null
  source_image_id:     string | null
  user_id:             string | null
  status:              VideoJobStatus
  requested_count:     number
  duration_seconds:    number
  aspect_ratio:        '1:1' | '16:9' | '9:16'
  model_name:          KlingModel
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

export interface CreativeVideo {
  id:                   string
  job_id:               string
  product_id:           string
  organization_id:      string
  position:             number
  prompt_text:          string
  status:               VideoStatus
  duration_seconds:     number
  aspect_ratio:         '1:1' | '16:9' | '9:16'
  model_name:           KlingModel
  external_task_id:     string | null
  source_image_id:      string | null
  storage_path:         string | null
  thumbnail_path:       string | null
  generation_metadata:  Record<string, unknown>
  regenerated_from_id:  string | null
  approved_at:          string | null
  approved_by:          string | null
  rejected_at:          string | null
  rejected_by:          string | null
  error_message:        string | null
  created_at:           string
  updated_at:           string
  signed_video_url?:    string | null
}

interface CreateVideoJobDto {
  product_id:        string
  briefing_id:       string
  listing_id?:       string
  source_image_id?:  string                   // se passado, usa imagem aprovada como first frame
  count?:            number                   // 1-5
  duration_seconds?: 5 | 10
  aspect_ratio?:     '1:1' | '16:9' | '9:16'
  model_name?:       KlingModel
  max_cost_usd?:     number
}

@Injectable()
export class CreativeVideoPipelineService {
  private readonly logger = new Logger(CreativeVideoPipelineService.name)
  private processing = new Set<string>()

  constructor(
    private readonly llm:      LlmService,
    private readonly creative: CreativeService,
    private readonly kling:    KlingClient,
  ) {}

  // ════════════════════════════════════════════════════════════════════════
  // JOB CRUD
  // ════════════════════════════════════════════════════════════════════════

  async createJob(orgId: string, userId: string, dto: CreateVideoJobDto): Promise<CreativeVideoJob> {
    const product  = await this.creative.getProduct(orgId, dto.product_id)
    const briefing = await this.creative.getBriefing(orgId, dto.briefing_id)
    if (briefing.product_id !== product.id) {
      throw new BadRequestException('briefing não pertence a esse produto')
    }

    // Valida source_image_id se fornecido (deve pertencer ao mesmo produto)
    if (dto.source_image_id) {
      const { data: srcImg } = await supabaseAdmin
        .from('creative_images')
        .select('id, product_id, organization_id, status')
        .eq('id', dto.source_image_id)
        .maybeSingle()
      if (!srcImg || (srcImg as { organization_id: string }).organization_id !== orgId) {
        throw new BadRequestException('source_image_id não encontrado')
      }
      if ((srcImg as { product_id: string }).product_id !== product.id) {
        throw new BadRequestException('source_image pertence a outro produto')
      }
    }

    const count = clamp(dto.count ?? 3, 1, 5)
    const duration = (dto.duration_seconds ?? 5) as 5 | 10
    const aspect = dto.aspect_ratio ?? mapAspectFromBriefing(briefing.image_format)
    const model: KlingModel = dto.model_name ?? 'kling-v2-master'
    const maxCost = Math.max(0.5, Math.min(20, dto.max_cost_usd ?? 5.0))

    const { data, error } = await supabaseAdmin
      .from('creative_video_jobs')
      .insert({
        organization_id:   orgId,
        product_id:        product.id,
        briefing_id:       briefing.id,
        listing_id:        dto.listing_id ?? null,
        source_image_id:   dto.source_image_id ?? null,
        user_id:           userId,
        status:            'queued',
        requested_count:   count,
        duration_seconds:  duration,
        aspect_ratio:      aspect,
        model_name:        model,
        max_cost_usd:      maxCost,
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`createVideoJob: ${error.message}`)
    this.logger.log(`[creative.video] job ${data.id} criado — count=${count} ${duration}s ${aspect} ${model} maxCost=$${maxCost}`)
    return data as CreativeVideoJob
  }

  async getJob(orgId: string, jobId: string): Promise<CreativeVideoJob> {
    const { data, error } = await supabaseAdmin
      .from('creative_video_jobs')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', jobId)
      .maybeSingle()
    if (error) throw new BadRequestException(`getVideoJob: ${error.message}`)
    if (!data) throw new NotFoundException('job de vídeo não encontrado')
    return data as CreativeVideoJob
  }

  async listJobsByProduct(orgId: string, productId: string): Promise<CreativeVideoJob[]> {
    await this.creative.getProduct(orgId, productId)
    const { data, error } = await supabaseAdmin
      .from('creative_video_jobs')
      .select('*')
      .eq('organization_id', orgId)
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw new BadRequestException(`listVideoJobsByProduct: ${error.message}`)
    return (data ?? []) as CreativeVideoJob[]
  }

  async listVideosByJob(orgId: string, jobId: string): Promise<CreativeVideo[]> {
    await this.getJob(orgId, jobId)
    const { data, error } = await supabaseAdmin
      .from('creative_videos')
      .select('*')
      .eq('organization_id', orgId)
      .eq('job_id', jobId)
      .order('position', { ascending: true })
    if (error) throw new BadRequestException(`listVideosByJob: ${error.message}`)
    const videos = (data ?? []) as CreativeVideo[]
    return Promise.all(videos.map(async v => ({
      ...v,
      signed_video_url: v.storage_path
        ? await this.creative.signImage(v.storage_path, 3600).catch(() => null)
        : null,
    })))
  }

  async cancelJob(orgId: string, jobId: string): Promise<CreativeVideoJob> {
    const job = await this.getJob(orgId, jobId)
    if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed') return job
    const { data, error } = await supabaseAdmin
      .from('creative_video_jobs')
      .update({ status: 'cancelled', updated_at: new Date().toISOString(), completed_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', jobId)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`cancelVideoJob: ${error.message}`)
    return data as CreativeVideoJob
  }

  // ════════════════════════════════════════════════════════════════════════
  // PER-VIDEO ACTIONS
  // ════════════════════════════════════════════════════════════════════════

  async getVideo(orgId: string, videoId: string): Promise<CreativeVideo> {
    const { data, error } = await supabaseAdmin
      .from('creative_videos')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', videoId)
      .maybeSingle()
    if (error) throw new BadRequestException(`getVideo: ${error.message}`)
    if (!data) throw new NotFoundException('vídeo não encontrado')
    return data as CreativeVideo
  }

  async approveVideo(orgId: string, videoId: string, userId: string): Promise<CreativeVideo> {
    const v = await this.getVideo(orgId, videoId)
    if (v.status === 'approved') return v
    if (v.status !== 'ready' && v.status !== 'rejected') {
      throw new BadRequestException(`não pode aprovar vídeo com status='${v.status}'`)
    }
    const { data, error } = await supabaseAdmin
      .from('creative_videos')
      .update({
        status: 'approved', approved_at: new Date().toISOString(), approved_by: userId,
        rejected_at: null, rejected_by: null, updated_at: new Date().toISOString(),
      })
      .eq('organization_id', orgId).eq('id', videoId)
      .select('*').single()
    if (error) throw new BadRequestException(`approveVideo: ${error.message}`)
    await this.recountJob(v.job_id)
    return data as CreativeVideo
  }

  async rejectVideo(orgId: string, videoId: string, userId: string): Promise<CreativeVideo> {
    const v = await this.getVideo(orgId, videoId)
    if (v.status === 'rejected') return v
    const { data, error } = await supabaseAdmin
      .from('creative_videos')
      .update({
        status: 'rejected', rejected_at: new Date().toISOString(), rejected_by: userId,
        approved_at: null, approved_by: null, updated_at: new Date().toISOString(),
      })
      .eq('organization_id', orgId).eq('id', videoId)
      .select('*').single()
    if (error) throw new BadRequestException(`rejectVideo: ${error.message}`)
    await this.recountJob(v.job_id)
    return data as CreativeVideo
  }

  /** Bulk regenerate: cria 1 novo vídeo `pending` por vídeo rejeitado do job. */
  async regenerateAllRejected(orgId: string, jobId: string): Promise<{ regenerated: number; skipped_cost_cap: boolean }> {
    const job = await this.getJob(orgId, jobId)
    if (job.total_cost_usd >= job.max_cost_usd) {
      return { regenerated: 0, skipped_cost_cap: true }
    }

    const { data: rejected, error } = await supabaseAdmin
      .from('creative_videos')
      .select('id, position, prompt_text, product_id, duration_seconds, aspect_ratio, model_name, source_image_id')
      .eq('organization_id', orgId)
      .eq('job_id', jobId)
      .eq('status', 'rejected')
    if (error) throw new BadRequestException(`regenerateAllRejected.list: ${error.message}`)
    if (!rejected || rejected.length === 0) return { regenerated: 0, skipped_cost_cap: false }

    const rows = (rejected as Array<{
      id: string; position: number; prompt_text: string; product_id: string;
      duration_seconds: number; aspect_ratio: string; model_name: string; source_image_id: string | null
    }>).map(r => ({
      job_id:              jobId,
      product_id:          r.product_id,
      organization_id:     orgId,
      position:            r.position,
      prompt_text:         r.prompt_text,
      status:              'pending' as const,
      duration_seconds:    r.duration_seconds,
      aspect_ratio:        r.aspect_ratio,
      model_name:          r.model_name,
      source_image_id:     r.source_image_id,
      regenerated_from_id: r.id,
    }))

    const { error: insertErr } = await supabaseAdmin.from('creative_videos').insert(rows)
    if (insertErr) throw new BadRequestException(`regenerateAllRejected.insert: ${insertErr.message}`)

    await supabaseAdmin
      .from('creative_video_jobs')
      .update({ status: 'generating_videos', completed_at: null, updated_at: new Date().toISOString() })
      .eq('id', jobId)
      .in('status', ['completed', 'generating_videos', 'failed'])

    return { regenerated: rows.length, skipped_cost_cap: false }
  }

  async regenerateVideo(orgId: string, videoId: string, customPrompt?: string): Promise<CreativeVideo> {
    const original = await this.getVideo(orgId, videoId)
    const job = await this.getJob(orgId, original.job_id)
    if (job.total_cost_usd >= job.max_cost_usd) {
      throw new BadRequestException('limite de custo do job atingido — crie um novo job')
    }
    const { data, error } = await supabaseAdmin
      .from('creative_videos')
      .insert({
        job_id:              original.job_id,
        product_id:          original.product_id,
        organization_id:     orgId,
        position:            original.position,
        prompt_text:         customPrompt?.trim() || original.prompt_text,
        status:              'pending',
        duration_seconds:    original.duration_seconds,
        aspect_ratio:        original.aspect_ratio,
        model_name:          original.model_name,
        source_image_id:     original.source_image_id,
        regenerated_from_id: original.id,
      })
      .select('*').single()
    if (error) throw new BadRequestException(`regenerateVideo.insert: ${error.message}`)

    // Re-coloca job em generating_videos
    await supabaseAdmin
      .from('creative_video_jobs')
      .update({ status: 'generating_videos', updated_at: new Date().toISOString(), completed_at: null })
      .eq('id', original.job_id)
      .in('status', ['completed', 'generating_videos', 'failed'])

    return data as CreativeVideo
  }

  // ════════════════════════════════════════════════════════════════════════
  // WORKER PIPELINE
  // ════════════════════════════════════════════════════════════════════════

  /** Lista todos os jobs ATIVOS (queued / generating_*). Worker processa
   *  cada um em sequência. Diferente da E2 — Kling é async, ticks múltiplos
   *  são esperados pra cada job. */
  async listActiveJobs(maxJobs = 5): Promise<CreativeVideoJob[]> {
    const { data, error } = await supabaseAdmin
      .from('creative_video_jobs')
      .select('*')
      .in('status', ['queued', 'generating_prompts', 'generating_videos'])
      .order('created_at', { ascending: true })
      .limit(maxJobs)
    if (error) {
      this.logger.warn(`[listActiveJobs] ${error.message}`)
      return []
    }
    return (data ?? []) as CreativeVideoJob[]
  }

  /** Avança UM passo no estado do job. Idempotente — múltiplos ticks ok.
   *
   *  Estados:
   *   - queued/generating_prompts (sem prompts) → gera prompts
   *   - generating_videos com videos pending    → submete pro Kling
   *   - generating_videos com videos generating → poll Kling
   *   - sem mais videos abertos                 → finaliza
   */
  async processJob(jobId: string): Promise<void> {
    if (this.processing.has(jobId)) return
    this.processing.add(jobId)
    try {
      const job = await this.getJobById(jobId)
      if (!job) return
      if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed') return

      // Etapa 1: prompts
      if (!job.prompts_generated || job.prompts_generated.length === 0) {
        await this.generatePrompts(job)
        return // próximo tick faz o submit
      }

      // Etapa 2: cost cap
      const refreshed = await this.getJobById(jobId)
      if (!refreshed) return
      if (refreshed.total_cost_usd >= refreshed.max_cost_usd) {
        this.logger.warn(`[creative.video] job ${jobId} max_cost atingido`)
        await this.markJobFailed(jobId, `Limite de custo $${refreshed.max_cost_usd} atingido`)
        return
      }

      // Etapa 3: submeter pendentes
      await this.submitPendingVideos(jobId)

      // Etapa 4: pollear gerando
      await this.pollGeneratingVideos(jobId)

      // Etapa 5: finalize se aplicável
      await this.finalizeJob(jobId)
    } catch (e: unknown) {
      this.logger.error(`[processVideoJob ${jobId}] ${(e as Error).message}`)
      await this.markJobFailed(jobId, (e as Error).message)
    } finally {
      this.processing.delete(jobId)
    }
  }

  private async getJobById(jobId: string): Promise<CreativeVideoJob | null> {
    const { data } = await supabaseAdmin
      .from('creative_video_jobs')
      .select('*')
      .eq('id', jobId)
      .maybeSingle()
    return (data as CreativeVideoJob) ?? null
  }

  private async generatePrompts(job: CreativeVideoJob): Promise<void> {
    const product  = await this.creative.getProduct(job.organization_id, job.product_id)
    const briefing = await this.creative.getBriefing(job.organization_id, job.briefing_id)

    await supabaseAdmin
      .from('creative_video_jobs')
      .update({ status: 'generating_prompts', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', job.id)

    // Reaproveita base editavel de prompts do briefing quando preenchida
    // (bloco 3 do workflow). Falha pra Sonnet on-demand quando vazia.
    const baseVideoPrompts = briefing.video_prompts ?? []
    let prompts: string[] = []
    let promptsMetadata: Record<string, unknown> = {}
    let promptsCostUsd = 0

    if (baseVideoPrompts.length > 0) {
      prompts = Array.from({ length: job.requested_count }, (_, i) => baseVideoPrompts[i % baseVideoPrompts.length])
      promptsMetadata = { source: 'briefing.video_prompts', base_count: baseVideoPrompts.length }
    } else {
      const out = await this.llm.generateText({
        orgId:      job.organization_id,
        feature:    'creative_video_prompts',
        userPrompt: buildVideoPromptsRequest({
          product:  {
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
          count:       job.requested_count,
          durationSec: (job.duration_seconds === 10 ? 10 : 5),
          aspectRatio: job.aspect_ratio,
        }),
        jsonMode:  true,
        maxTokens: 3000,
        creative:  { productId: product.id, operation: 'video_prompt_generation' },
      })

      prompts = parsePromptsArray(out.text, job.requested_count)
      promptsMetadata = {
        source:        'on_demand',
        provider:      out.provider,
        model:         out.model,
        input_tokens:  out.inputTokens,
        output_tokens: out.outputTokens,
        cost_usd:      out.costUsd,
        latency_ms:    out.latencyMs,
      }
      promptsCostUsd = out.costUsd
    }

    if (prompts.length === 0) {
      throw new Error('Nenhum prompt valido (base do briefing vazia + LLM falhou)')
    }

    const rows = prompts.map((prompt, i) => ({
      job_id:           job.id,
      product_id:       job.product_id,
      organization_id:  job.organization_id,
      position:         i + 1,
      prompt_text:      prompt,
      status:           'pending' as const,
      duration_seconds: job.duration_seconds,
      aspect_ratio:     job.aspect_ratio,
      model_name:       job.model_name,
      source_image_id:  job.source_image_id,
    }))
    const { error: insertErr } = await supabaseAdmin.from('creative_videos').insert(rows)
    if (insertErr) throw new Error(`creative_videos.insert: ${insertErr.message}`)

    await supabaseAdmin
      .from('creative_video_jobs')
      .update({
        status:            'generating_videos',
        prompts_generated: prompts,
        prompts_metadata:  promptsMetadata,
        total_cost_usd:    promptsCostUsd,
        updated_at:        new Date().toISOString(),
      })
      .eq('id', job.id)

    this.logger.log(`[creative.video] job ${job.id} prompts: ${prompts.length} gerados`)
  }

  /** Submete TODAS as videos pending do job pro Kling em paralelo.
   *  Limita a 3 submits paralelos pra não tomar burst limit do Kling. */
  private async submitPendingVideos(jobId: string): Promise<void> {
    const { data: pending } = await supabaseAdmin
      .from('creative_videos')
      .select('*')
      .eq('job_id', jobId)
      .eq('status', 'pending')
      .order('position', { ascending: true })
    if (!pending || pending.length === 0) return

    const videos = pending as CreativeVideo[]
    // Submete em batches de 3
    for (let i = 0; i < videos.length; i += 3) {
      const batch = videos.slice(i, i + 3)
      await Promise.all(batch.map(v => this.submitOne(v)))
    }
  }

  private async submitOne(video: CreativeVideo): Promise<void> {
    try {
      // Resolve source URL (signed): preferência por source_image se passado, senão main_image
      const sourceUrl = await this.resolveSourceUrl(video)

      const { taskId } = await this.kling.submitImage2Video({
        imageUrl:    sourceUrl,
        prompt:      video.prompt_text,
        duration:    String(video.duration_seconds) as KlingDuration,
        aspectRatio: video.aspect_ratio as KlingAspectRatio,
        modelName:   video.model_name,
      })

      await supabaseAdmin
        .from('creative_videos')
        .update({
          status:           'generating',
          external_task_id: taskId,
          updated_at:       new Date().toISOString(),
        })
        .eq('id', video.id)

      this.logger.log(`[creative.video] vid ${video.id} submetido — task=${taskId}`)
    } catch (e: unknown) {
      const msg = (e as Error).message
      await supabaseAdmin
        .from('creative_videos')
        .update({ status: 'failed', error_message: msg, updated_at: new Date().toISOString() })
        .eq('id', video.id)
      await this.bumpJobAfterVideo(video.job_id, 0, false)
      this.logger.error(`[creative.video] vid ${video.id} submit falhou: ${msg}`)
    }
  }

  private async resolveSourceUrl(video: CreativeVideo): Promise<string> {
    // Se source_image_id, usa a imagem aprovada; senão main_image_storage_path
    if (video.source_image_id) {
      const { data } = await supabaseAdmin
        .from('creative_images')
        .select('storage_path')
        .eq('id', video.source_image_id)
        .maybeSingle()
      const path = (data as { storage_path: string | null } | null)?.storage_path
      if (path) return this.creative.signImage(path, 600)
    }
    const product = await this.creative.getProduct(video.organization_id, video.product_id)
    return this.creative.signImage(product.main_image_storage_path, 600)
  }

  /** Para cada video em status='generating' com external_task_id, pollea
   *  o Kling. Se succeed → baixa + sobe pro Storage + marca ready. Se
   *  failed → marca failed. */
  private async pollGeneratingVideos(jobId: string): Promise<void> {
    const { data: generating } = await supabaseAdmin
      .from('creative_videos')
      .select('*')
      .eq('job_id', jobId)
      .eq('status', 'generating')
      .not('external_task_id', 'is', null)
      .order('position', { ascending: true })
    if (!generating || generating.length === 0) return

    const videos = generating as CreativeVideo[]
    // Poll em paralelo (cada poll é só 1 GET)
    await Promise.all(videos.map(v => this.pollOne(v)))
  }

  private async pollOne(video: CreativeVideo): Promise<void> {
    if (!video.external_task_id) return
    try {
      const info = await this.kling.getTaskStatus(video.external_task_id)

      if (info.status === 'submitted' || info.status === 'processing') return // ainda gerando, próximo tick

      if (info.status === 'failed') {
        await supabaseAdmin
          .from('creative_videos')
          .update({
            status: 'failed',
            error_message: `Kling: ${info.statusMsg ?? 'failed'}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', video.id)
        await this.bumpJobAfterVideo(video.job_id, 0, false)
        return
      }

      if (info.status === 'succeed') {
        const url = info.videos?.[0]?.url
        if (!url) throw new Error('Kling retornou status=succeed mas sem URL')

        const buffer = await this.kling.downloadVideo(url)
        const storagePath = `${video.organization_id}/${video.product_id}/videos/${video.id}.mp4`
        const { error: upErr } = await supabaseAdmin.storage
          .from('creative')
          .upload(storagePath, buffer, { contentType: 'video/mp4', upsert: true, cacheControl: '3600' })
        if (upErr) throw new Error(`storage.upload: ${upErr.message}`)

        const cost = this.kling.estimateCost(video.model_name, String(video.duration_seconds) as KlingDuration)

        await supabaseAdmin
          .from('creative_videos')
          .update({
            status:       'ready',
            storage_path: storagePath,
            generation_metadata: {
              provider:   'kling',
              model:      video.model_name,
              duration:   video.duration_seconds,
              aspect:     video.aspect_ratio,
              cost_usd:   cost,
              kling_task: video.external_task_id,
            },
            error_message: null,
            updated_at:    new Date().toISOString(),
          })
          .eq('id', video.id)

        // Log direto em ai_usage_log (Kling não passa por LlmService)
        await supabaseAdmin.from('ai_usage_log').insert({
          organization_id:     video.organization_id,
          provider:            'kling',
          model:               video.model_name,
          feature:             'creative_video',
          tokens_input:        0,
          tokens_output:       0,
          tokens_total:        0,
          cost_usd:            cost,
          latency_ms:          0, // Kling é async, não dá pra medir client-side
          fallback_used:       false,
          error_message:       null,
          creative_product_id: video.product_id,
          creative_video_id:   video.id,
          creative_operation:  'video_generation',
        })

        await this.bumpJobAfterVideo(video.job_id, cost, true)
        this.logger.log(`[creative.video] vid ${video.id} pos=${video.position} ✓ cost=$${cost}`)
      }
    } catch (e: unknown) {
      const msg = (e as Error).message
      await supabaseAdmin
        .from('creative_videos')
        .update({ status: 'failed', error_message: msg, updated_at: new Date().toISOString() })
        .eq('id', video.id)
      await this.bumpJobAfterVideo(video.job_id, 0, false)
      this.logger.error(`[creative.video] vid ${video.id} poll falhou: ${msg}`)
    }
  }

  private async bumpJobAfterVideo(jobId: string, costUsd: number, ok: boolean): Promise<void> {
    const { data } = await supabaseAdmin
      .from('creative_video_jobs')
      .select('total_cost_usd, completed_count, failed_count')
      .eq('id', jobId)
      .maybeSingle()
    if (!data) return
    const row = data as { total_cost_usd: number; completed_count: number; failed_count: number }
    await supabaseAdmin
      .from('creative_video_jobs')
      .update({
        total_cost_usd:  Number(row.total_cost_usd) + costUsd,
        completed_count: row.completed_count + (ok ? 1 : 0),
        failed_count:    row.failed_count    + (ok ? 0 : 1),
        updated_at:      new Date().toISOString(),
      })
      .eq('id', jobId)
  }

  private async finalizeJob(jobId: string): Promise<void> {
    const { count: openCount } = await supabaseAdmin
      .from('creative_videos')
      .select('id', { count: 'exact', head: true })
      .eq('job_id', jobId)
      .in('status', ['pending', 'generating'])

    if ((openCount ?? 0) > 0) return

    await supabaseAdmin
      .from('creative_video_jobs')
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
      .from('creative_video_jobs')
      .update({
        status:        'failed',
        error_message: message,
        completed_at:  new Date().toISOString(),
        updated_at:    new Date().toISOString(),
      })
      .eq('id', jobId)
  }

  /** Cleanup: jobs zumbis em 'generating_*' há >jobMaxMinutes vira failed,
   *  vídeos em 'generating' há >vidMaxMinutes (default 15min — Kling normalmente
   *  retorna em 1-3min, 15min indica problema) vira failed. */
  async cleanupStale(opts: { jobMaxMinutes?: number; vidMaxMinutes?: number } = {}): Promise<{ jobsFailed: number; videosFailed: number }> {
    const jobCutoff = new Date(Date.now() - (opts.jobMaxMinutes ?? 90) * 60 * 1000).toISOString()
    const vidCutoff = new Date(Date.now() - (opts.vidMaxMinutes ?? 15) * 60 * 1000).toISOString()

    const { data: vids, error: vidErr } = await supabaseAdmin
      .from('creative_videos')
      .update({
        status:        'failed',
        error_message: 'Cleanup automático — vídeo ficou em generating por tempo excessivo (Kling pode ter falhado silenciosamente)',
        updated_at:    new Date().toISOString(),
      })
      .eq('status', 'generating')
      .lt('updated_at', vidCutoff)
      .select('id, job_id')

    if (vidErr) this.logger.warn(`[cleanup.videosFailed] ${vidErr.message}`)
    const videosFailed = (vids ?? []).length

    const affectedJobIds = Array.from(new Set((vids ?? []).map(v => (v as { job_id: string }).job_id)))
    for (const jobId of affectedJobIds) {
      const failedInJob = (vids ?? []).filter(v => (v as { job_id: string }).job_id === jobId).length
      const { data: job } = await supabaseAdmin
        .from('creative_video_jobs')
        .select('failed_count')
        .eq('id', jobId)
        .maybeSingle()
      if (job) {
        await supabaseAdmin
          .from('creative_video_jobs')
          .update({ failed_count: (job as { failed_count: number }).failed_count + failedInJob, updated_at: new Date().toISOString() })
          .eq('id', jobId)
      }
    }

    const { data: jobs, error: jobErr } = await supabaseAdmin
      .from('creative_video_jobs')
      .update({
        status:        'failed',
        error_message: 'Cleanup automático — job ficou ativo por tempo excessivo (>1h30)',
        completed_at:  new Date().toISOString(),
        updated_at:    new Date().toISOString(),
      })
      .in('status', ['queued', 'generating_prompts', 'generating_videos'])
      .lt('updated_at', jobCutoff)
      .select('id')

    if (jobErr) this.logger.warn(`[cleanup.jobsFailed] ${jobErr.message}`)
    const jobsFailed = (jobs ?? []).length

    if (videosFailed > 0 || jobsFailed > 0) {
      this.logger.log(`[cleanup.videos] ${jobsFailed} jobs + ${videosFailed} vídeos zumbis marcados como failed`)
    }
    return { jobsFailed, videosFailed }
  }

  async recountJob(jobId: string): Promise<void> {
    const { data } = await supabaseAdmin
      .from('creative_videos')
      .select('status')
      .eq('job_id', jobId)
    if (!data) return
    const rows = data as Array<{ status: VideoStatus }>
    await supabaseAdmin
      .from('creative_video_jobs')
      .update({
        approved_count: rows.filter(r => r.status === 'approved').length,
        rejected_count: rows.filter(r => r.status === 'rejected').length,
        updated_at:     new Date().toISOString(),
      })
      .eq('id', jobId)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function parsePromptsArray(text: string, expected: number): string[] {
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  let parsed: unknown
  try { parsed = JSON.parse(cleaned) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return parsed
    .map(p => typeof p === 'string' ? p.trim() : '')
    .filter(p => p.length > 0)
    .slice(0, expected)
}

/** Mapeia o image_format do briefing pra um aspect ratio que Kling aceita. */
function mapAspectFromBriefing(format: string): '1:1' | '16:9' | '9:16' {
  if (format === '1200x1500') return '9:16' // não exato (4:5) mas mais próximo
  return '1:1' // 1200x1200, 1000x1000, 800x800
}
