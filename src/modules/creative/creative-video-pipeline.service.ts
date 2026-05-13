import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'
import { CreativeService, type CreativeProduct } from './creative.service'
import { buildVideoPromptsRequest } from './creative.prompts'
import { KlingClient } from './kling.client'
import { VideoProviderRegistry } from './providers/video-provider.registry'
import type { Marketplace } from './creative.marketplace-rules'
import { extractLastFrame, concatVideos } from '../../common/ffmpeg'
import { adaptImageForVideo, type TargetAspect } from './image-adapter'

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
  model_name:          string
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
  // F6: chain (vídeos longos 15s+)
  target_duration_seconds: number | null
  source_provider:        'kling' | 'flow' | null
  camera_motion:          string | null
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
  model_name:           string
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
  // F6: chain fields
  parent_video_id:      string | null
  chain_position:       number | null
  chain_total:          number | null
  is_chain_master:      boolean
  chain_master_id:      string | null
  provider:             'kling' | 'flow'
  quality:              string | null
  source_frame_path:    string | null
}

interface CreateVideoJobDto {
  product_id:        string
  briefing_id:       string
  listing_id?:       string
  source_image_id?:  string                   // se passado, usa imagem aprovada como first frame
  count?:            number                   // 1-5
  duration_seconds?: 5 | 10
  aspect_ratio?:     '1:1' | '16:9' | '9:16'
  model_name?:       string
  max_cost_usd?:     number
}

/** F6: input pra gerar UM vídeo longo (15s+) a partir de uma imagem aprovada.
 *  Pipeline encadeia 2-3 partes Kling (5 ou 10s cada) e concatena no final. */
export interface CreateChainedVideoFromImageDto {
  product_id:        string
  briefing_id:       string
  listing_id?:       string
  /** Obrigatório — imagem aprovada que vira first_frame do 1º part da chain. */
  source_image_id:   string
  /** Duração total alvo em segundos (15, 20, 25, 30). Pipeline calcula parts. */
  target_duration_seconds: number
  aspect_ratio?:     '1:1' | '16:9' | '9:16'
  model_name?:       string
  /** Movimento de câmera padrão pra todos os parts. Default: dolly-in (zoom em direção ao produto). */
  camera_motion?:    'dolly-in' | 'dolly-out' | 'pan-left' | 'pan-right' | 'tilt-up' | 'tilt-down' | 'orbit' | 'static'
  /** Cap de custo. Default $5. */
  max_cost_usd?:     number
  /** Prompt customizado opcional pra todos os parts. */
  prompt?:           string
}

@Injectable()
export class CreativeVideoPipelineService {
  private readonly logger = new Logger(CreativeVideoPipelineService.name)
  private processing = new Set<string>()

  constructor(
    private readonly llm:      LlmService,
    private readonly creative: CreativeService,
    private readonly kling:    KlingClient,            // mantido pro estimateCost legado em alguns paths
    private readonly registry: VideoProviderRegistry,  // F6: dispatch multi-provider (Kling / Flow)
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
    const duration = (dto.duration_seconds ?? 10) as 5 | 10
    const aspect = dto.aspect_ratio ?? mapAspectFromBriefing(briefing.image_format)
    // F6: aceita modelos Kling OU Veo (Flow) — resolução acontece no submit via registry
    const model: string = dto.model_name ?? 'kling-v2-6'
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

  // ════════════════════════════════════════════════════════════════════════
  // F6: CHAINED VIDEO (15s+) — gera UM vídeo longo a partir de imagem aprovada
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Cria um job que vai gerar UM vídeo longo (15-30s) encadeando parts Kling.
   *
   * Fluxo do pipeline:
   *   1. Este método cria o job + a 1ª part (chain_position=1) com source_image_id
   *   2. Worker submete part 1 → quando ready, baixa MP4 do Storage
   *   3. ffmpeg extrai last frame → upload PNG pro Storage
   *   4. Cria part 2 (chain_position=2) com source_frame_path apontando pro PNG
   *   5. Repete até completar target_duration
   *   6. Quando última part ready: ffmpeg concatena todos parts em 1 MP4 → cria master
   */
  async createChainedJobFromImage(
    orgId: string, userId: string, dto: CreateChainedVideoFromImageDto,
  ): Promise<CreativeVideoJob> {
    const product  = await this.creative.getProduct(orgId, dto.product_id)
    const briefing = await this.creative.getBriefing(orgId, dto.briefing_id)
    if (briefing.product_id !== product.id) {
      throw new BadRequestException('briefing não pertence a esse produto')
    }
    if (!dto.source_image_id) {
      throw new BadRequestException('source_image_id obrigatório pra vídeo encadeado')
    }

    // Valida source image
    const { data: srcImg } = await supabaseAdmin
      .from('creative_images')
      .select('id, product_id, organization_id, status, storage_path')
      .eq('id', dto.source_image_id)
      .maybeSingle()
    if (!srcImg || (srcImg as { organization_id: string }).organization_id !== orgId) {
      throw new BadRequestException('source_image_id não encontrado')
    }
    if ((srcImg as { product_id: string }).product_id !== product.id) {
      throw new BadRequestException('source_image pertence a outro produto')
    }
    const srcStatus = (srcImg as { status: string }).status
    if (srcStatus !== 'ready' && srcStatus !== 'approved') {
      throw new BadRequestException(`source_image precisa estar ready ou approved, atual: ${srcStatus}`)
    }

    const targetDuration = clamp(dto.target_duration_seconds, 5, 60)
    const aspect       = dto.aspect_ratio ?? mapAspectFromBriefing(briefing.image_format)
    // F6: aceita Kling OU Veo (Flow) — resolução acontece no submit via registry
    const model: string = dto.model_name ?? 'kling-v2-6'
    const cameraMotion = dto.camera_motion ?? 'dolly-in'
    const maxCost = Math.max(0.5, Math.min(20, dto.max_cost_usd ?? 5.0))

    // Calcula partes — depende do provider:
    //   Kling [5,10]    → ex: target 15 = [10,5]; 30 = [10,10,10]
    //   Veo   [4,6,8]   → ex: target 15 ≈ 18 [8,6,4]; 20 = [8,8,4]; 30 ≈ 32 [8,8,8,8]
    // Pequeno overshoot aceito (sec extras) pra não quebrar UX. Master concat
    // entrega o vídeo no tamanho real.
    const provider = this.registry.resolve(model)
    const modelOpt = provider.listModels().find(m => m.id === model)
    if (!modelOpt) {
      throw new BadRequestException(`Modelo ${model} não disponível no provider ${provider.key}.`)
    }
    const { parts, actualTarget } = computeChainParts(targetDuration, modelOpt.supportedDurations)
    const chainTotal = parts.length

    if (chainTotal > 5) {
      throw new BadRequestException(`target_duration_seconds ${targetDuration} resulta em ${chainTotal} parts (max 5). Use até 30s.`)
    }
    if (chainTotal === 0) {
      throw new BadRequestException(`Não foi possível compor ${targetDuration}s com durações suportadas pelo modelo: ${modelOpt.supportedDurations.join('/')}`)
    }

    // 1. Cria job
    const { data: jobData, error: jobErr } = await supabaseAdmin
      .from('creative_video_jobs')
      .insert({
        organization_id:         orgId,
        product_id:              product.id,
        briefing_id:             briefing.id,
        listing_id:              dto.listing_id ?? null,
        source_image_id:         dto.source_image_id,
        user_id:                 userId,
        status:                  'generating_videos',  // pula generating_prompts, já temos prompt
        requested_count:         chainTotal,
        duration_seconds:        parts[0],             // duration da 1ª part (refs antigos)
        aspect_ratio:            aspect,
        model_name:              model,
        max_cost_usd:            maxCost,
        target_duration_seconds: actualTarget,
        source_provider:         provider.key,
        camera_motion:           cameraMotion,
        prompts_generated:       [],
        prompts_metadata:        { source: 'chain_from_image', chain_total: chainTotal, parts, requested_target: targetDuration, actual_target: actualTarget },
      })
      .select('*')
      .single()
    if (jobErr) throw new BadRequestException(`createChainedJob: ${jobErr.message}`)
    const job = jobData as CreativeVideoJob

    // 2. Resolve prompt (custom > video_prompts[0] > template padrão)
    const baseVideoPrompts = briefing.video_prompts ?? []
    const promptText = (dto.prompt?.trim() || baseVideoPrompts[0] || this.defaultMotionPrompt(cameraMotion))

    // 3. Cria SÓ a 1ª part (próximas viram criadas conforme advance)
    const { error: vidErr } = await supabaseAdmin
      .from('creative_videos')
      .insert({
        job_id:           job.id,
        product_id:       product.id,
        organization_id:  orgId,
        position:         1,
        prompt_text:      promptText,
        status:           'pending',
        duration_seconds: parts[0],
        aspect_ratio:     aspect,
        model_name:       model,
        source_image_id:  dto.source_image_id,
        chain_position:   1,
        chain_total:      chainTotal,
        is_chain_master:  false,
        provider:         provider.key,
      })
    if (vidErr) throw new BadRequestException(`createChainedJob.videoInsert: ${vidErr.message}`)

    this.logger.log(
      `[creative.video.chain] job ${job.id} criado — target=${targetDuration}s actual=${actualTarget}s parts=[${parts.join(',')}] motion=${cameraMotion} provider=${provider.key} model=${model}`,
    )
    return job
  }

  /** Prompt padrão por movimento de câmera (usado quando user não passa custom). */
  private defaultMotionPrompt(motion: string): string {
    const base = 'Cinematic camera movement, smooth and subtle. The product remains perfectly still and identical to the source image — same shape, color, material, finish. Subtle parallax on background elements. Maintain photorealistic quality.'
    const motionMap: Record<string, string> = {
      'dolly-in':  'Smooth camera dolly forward toward the product, gradual zoom-in revealing detail. ' + base,
      'dolly-out': 'Smooth camera dolly backward, gradually revealing the surrounding environment. ' + base,
      'pan-left':  'Smooth camera pan to the left, gentle parallax. ' + base,
      'pan-right': 'Smooth camera pan to the right, gentle parallax. ' + base,
      'tilt-up':   'Smooth camera tilt upward. ' + base,
      'tilt-down': 'Smooth camera tilt downward. ' + base,
      'orbit':     'Smooth orbital camera movement around the product. ' + base,
      'static':    'Subtle ambient motion, camera holds steady. ' + base,
    }
    return motionMap[motion] ?? motionMap['dolly-in']
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

      // F6: chain mode bypassa generatePrompts (já temos prompt da chain)
      const isChainJob = (job.target_duration_seconds ?? 0) > 0

      // Etapa 1: prompts (só pro modo legado)
      if (!isChainJob && (!job.prompts_generated || job.prompts_generated.length === 0)) {
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

      // F6: chain — avança próxima part se a anterior ficou ready
      if (isChainJob) {
        await this.advanceChain(jobId)
      }

      // F6: chain — concatena MP4s e cria master quando todas parts ready
      if (isChainJob) {
        await this.tryFinalizeChain(jobId)
      }

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
      const rawSourceUrl = await this.resolveSourceUrl(video)

      // F6: adapta imagem pro aspect alvo (providers de vídeo herdam aspect
      // da source image — sem isso o vídeo sai no aspect da imagem original).
      // Se já bate, retorna URL original sem custo.
      const adaptedSourceUrl = await adaptImageForVideo({
        sourceUrl:    rawSourceUrl,
        targetAspect: video.aspect_ratio as TargetAspect,
        orgId:        video.organization_id,
        productId:    video.product_id,
        videoId:      video.id,
        creative:     this.creative,
        logger:       this.logger,
      })

      // F6: dispatch via registry — escolhe Kling ou Flow baseado no model_name prefix.
      const provider = this.registry.resolve(video.model_name)
      const { taskId } = await provider.submit({
        imageUrl:    adaptedSourceUrl,
        prompt:      video.prompt_text,
        duration:    Number(video.duration_seconds),
        aspectRatio: video.aspect_ratio,
        modelId:     video.model_name,
        orgId:       video.organization_id, // Flow usa pra resolver per-org credentials
      })

      await supabaseAdmin
        .from('creative_videos')
        .update({
          status:           'generating',
          external_task_id: taskId,
          updated_at:       new Date().toISOString(),
        })
        .eq('id', video.id)

      this.logger.log(`[creative.video] vid ${video.id} submetido — provider=${provider.key} task=${taskId}`)
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
    // F6: prioridade pra source_frame_path (last frame extraído de part anterior na chain)
    if (video.source_frame_path) {
      return this.creative.signImage(video.source_frame_path, 600)
    }
    // Senão source_image_id (imagem aprovada de marketing)
    if (video.source_image_id) {
      const { data } = await supabaseAdmin
        .from('creative_images')
        .select('storage_path')
        .eq('id', video.source_image_id)
        .maybeSingle()
      const path = (data as { storage_path: string | null } | null)?.storage_path
      if (path) return this.creative.signImage(path, 600)
    }
    // Fallback: main_image do produto
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
      // F6: dispatch via registry — Kling vs Flow conforme model prefix
      const provider = this.registry.resolve(video.model_name)
      const ctx = { orgId: video.organization_id }
      const info = await provider.pollStatus(video.external_task_id, ctx)

      if (info.status === 'submitted' || info.status === 'processing') return // ainda gerando, próximo tick

      if (info.status === 'failed') {
        await supabaseAdmin
          .from('creative_videos')
          .update({
            status: 'failed',
            error_message: `${provider.key}: ${info.statusMsg ?? 'failed'}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', video.id)
        await this.bumpJobAfterVideo(video.job_id, 0, false)
        return
      }

      if (info.status === 'succeed') {
        const url = info.videoUrl
        if (!url) throw new Error(`${provider.key} retornou status=succeed mas sem URL`)

        const buffer = await provider.download(url, ctx)
        const storagePath = `${video.organization_id}/${video.product_id}/videos/${video.id}.mp4`
        const { error: upErr } = await supabaseAdmin.storage
          .from('creative')
          .upload(storagePath, buffer, { contentType: 'video/mp4', upsert: true, cacheControl: '3600' })
        if (upErr) throw new Error(`storage.upload: ${upErr.message}`)

        const cost = provider.estimateCost(video.model_name, Number(video.duration_seconds))

        await supabaseAdmin
          .from('creative_videos')
          .update({
            status:       'ready',
            storage_path: storagePath,
            generation_metadata: {
              provider:    provider.key,
              model:       video.model_name,
              duration:    video.duration_seconds,
              aspect:      video.aspect_ratio,
              cost_usd:    cost,
              external_task: video.external_task_id,
            },
            error_message: null,
            updated_at:    new Date().toISOString(),
          })
          .eq('id', video.id)

        // Log direto em ai_usage_log (vídeo não passa por LlmService)
        await supabaseAdmin.from('ai_usage_log').insert({
          organization_id:     video.organization_id,
          provider:            provider.key,
          model:               video.model_name,
          feature:             'creative_video',
          tokens_input:        0,
          tokens_output:       0,
          tokens_total:        0,
          cost_usd:            cost,
          latency_ms:          0, // async — não dá pra medir client-side
          fallback_used:       false,
          error_message:       null,
          creative_product_id: video.product_id,
          creative_video_id:   video.id,
          creative_operation:  'video_generation',
        })

        await this.bumpJobAfterVideo(video.job_id, cost, true)
        this.logger.log(`[creative.video] vid ${video.id} pos=${video.position} ✓ provider=${provider.key} cost=$${cost}`)
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

  /**
   * F6 chain: avança a próxima part da cadeia quando a anterior ficou ready.
   * - Detecta última part ready com chain_position < chain_total
   * - Extrai último frame do MP4 via ffmpeg
   * - Upload PNG pro Storage
   * - Cria próxima part pending com source_frame_path apontando pro PNG
   */
  private async advanceChain(jobId: string): Promise<void> {
    // Pega última part ready dessa chain
    const { data: parts } = await supabaseAdmin
      .from('creative_videos')
      .select('*')
      .eq('job_id', jobId)
      .eq('is_chain_master', false)
      .order('chain_position', { ascending: false })
      .limit(1)
    const last = (parts as CreativeVideo[] | null)?.[0]
    if (!last) return
    if (last.status !== 'ready') return
    if (!last.chain_position || !last.chain_total) return
    if (last.chain_position >= last.chain_total) return  // chain completa
    if (!last.storage_path) return

    const nextPosition = last.chain_position + 1
    const job = await this.getJobById(jobId)
    if (!job) return

    // Checa se a próxima part já foi criada (race condition guard)
    const { count: existing } = await supabaseAdmin
      .from('creative_videos')
      .select('id', { count: 'exact', head: true })
      .eq('job_id', jobId)
      .eq('chain_position', nextPosition)
    if ((existing ?? 0) > 0) return

    // Calcula duração da próxima part — algoritmo guloso igual createChain
    const parts_meta = (job.prompts_metadata?.parts ?? []) as number[]
    const nextDuration = parts_meta[nextPosition - 1] ?? 5

    this.logger.log(`[chain ${jobId}] avançando ${last.chain_position}→${nextPosition} (${nextDuration}s) — extraindo last frame`)

    try {
      // Baixa MP4 da part anterior
      const { data: mp4Blob, error: dlErr } = await supabaseAdmin.storage
        .from('creative')
        .download(last.storage_path)
      if (dlErr || !mp4Blob) throw new Error(`download ${last.storage_path}: ${dlErr?.message ?? 'sem dados'}`)
      const mp4Buffer = Buffer.from(await mp4Blob.arrayBuffer())

      // Extrai último frame
      const framePngBuffer = await extractLastFrame(mp4Buffer)
      const framePath = `${last.organization_id}/${last.product_id}/videos/chain-frames/${last.id}-last.png`
      const { error: upErr } = await supabaseAdmin.storage
        .from('creative')
        .upload(framePath, framePngBuffer, { contentType: 'image/png', upsert: true, cacheControl: '3600' })
      if (upErr) throw new Error(`upload last frame: ${upErr.message}`)

      // Cria próxima part
      const { error: insertErr } = await supabaseAdmin
        .from('creative_videos')
        .insert({
          job_id:             jobId,
          product_id:         last.product_id,
          organization_id:    last.organization_id,
          position:           nextPosition,
          prompt_text:        last.prompt_text,  // reusa o prompt da chain
          status:             'pending',
          duration_seconds:   nextDuration,
          aspect_ratio:       last.aspect_ratio,
          model_name:         last.model_name,
          source_frame_path:  framePath,
          parent_video_id:    last.id,
          chain_position:     nextPosition,
          chain_total:        last.chain_total,
          is_chain_master:    false,
          provider:           last.provider,
        })
      if (insertErr) throw new Error(`insert next part: ${insertErr.message}`)

      this.logger.log(`[chain ${jobId}] part ${nextPosition}/${last.chain_total} criada — pending`)
    } catch (e: unknown) {
      const msg = (e as Error).message
      this.logger.error(`[chain ${jobId}] advance falhou: ${msg}`)
      // Marca o job como falho — sem next part, não tem como continuar
      await this.markJobFailed(jobId, `Chain advance: ${msg}`)
    }
  }

  /**
   * F6 chain: quando TODAS parts ready, concatena os MP4s em 1 master via ffmpeg.
   * Cria row creative_videos is_chain_master=true com storage_path do MP4 final.
   * Atualiza cada part com chain_master_id apontando pro master.
   */
  private async tryFinalizeChain(jobId: string): Promise<void> {
    // Já tem master? skip
    const { count: hasMaster } = await supabaseAdmin
      .from('creative_videos')
      .select('id', { count: 'exact', head: true })
      .eq('job_id', jobId)
      .eq('is_chain_master', true)
    if ((hasMaster ?? 0) > 0) return

    // Carrega todas parts (não-master) ordenadas por chain_position
    const { data: parts } = await supabaseAdmin
      .from('creative_videos')
      .select('*')
      .eq('job_id', jobId)
      .eq('is_chain_master', false)
      .order('chain_position', { ascending: true })
    const list = (parts ?? []) as CreativeVideo[]
    if (list.length === 0) return

    const total = list[0].chain_total
    if (!total || list.length < total) return  // chain incompleta
    if (list.some(p => p.status !== 'ready')) return  // alguma part ainda não terminou
    if (list.some(p => !p.storage_path)) return

    this.logger.log(`[chain ${jobId}] todas ${total} parts ready — concatenando MP4s`)

    try {
      // Baixa todos MP4s em ordem
      const buffers: Buffer[] = []
      for (const p of list) {
        const { data: blob, error } = await supabaseAdmin.storage
          .from('creative')
          .download(p.storage_path!)
        if (error || !blob) throw new Error(`download part ${p.chain_position}: ${error?.message}`)
        buffers.push(Buffer.from(await blob.arrayBuffer()))
      }

      // Concatena via ffmpeg
      const masterBuffer = await concatVideos(buffers)

      // Upload master
      const job = await this.getJobById(jobId)
      if (!job) throw new Error('job desapareceu durante concat')

      // Cria row master ANTES do upload pra ter ID pra usar no path
      const { data: masterRow, error: mErr } = await supabaseAdmin
        .from('creative_videos')
        .insert({
          job_id:             jobId,
          product_id:         job.product_id,
          organization_id:    job.organization_id,
          position:           total + 1,        // depois das parts no order by
          prompt_text:        list[0].prompt_text,
          status:             'ready',
          duration_seconds:   job.target_duration_seconds ?? list.reduce((s, p) => s + p.duration_seconds, 0),
          aspect_ratio:       list[0].aspect_ratio,
          model_name:         list[0].model_name,
          source_image_id:    job.source_image_id,
          is_chain_master:    true,
          chain_total:        total,
          provider:           list[0].provider,
          generation_metadata: {
            type:           'chain_master',
            parts_ids:      list.map(p => p.id),
            parts_durations: list.map(p => p.duration_seconds),
            total_duration_sec: job.target_duration_seconds ?? list.reduce((s, p) => s + p.duration_seconds, 0),
          },
        })
        .select('*')
        .single()
      if (mErr) throw new Error(`insert master: ${mErr.message}`)
      const master = masterRow as CreativeVideo

      const masterPath = `${job.organization_id}/${job.product_id}/videos/${master.id}.mp4`
      const { error: upErr } = await supabaseAdmin.storage
        .from('creative')
        .upload(masterPath, masterBuffer, { contentType: 'video/mp4', upsert: true, cacheControl: '3600' })
      if (upErr) throw new Error(`upload master: ${upErr.message}`)

      // Atualiza master com path + aponta parts pra ele
      await supabaseAdmin
        .from('creative_videos')
        .update({ storage_path: masterPath, updated_at: new Date().toISOString() })
        .eq('id', master.id)

      await supabaseAdmin
        .from('creative_videos')
        .update({ chain_master_id: master.id, updated_at: new Date().toISOString() })
        .in('id', list.map(p => p.id))

      this.logger.log(`[chain ${jobId}] master ${master.id} criado — ${masterBuffer.length} bytes, ${master.duration_seconds}s`)
    } catch (e: unknown) {
      const msg = (e as Error).message
      this.logger.error(`[chain ${jobId}] finalize falhou: ${msg}`)
      // Não marca job como failed — parts individuais funcionam, user pode aprovar elas
      // separadamente. Master pode ser retentado em próximo tick.
    }
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

/**
 * Compõe as partes da chain a partir das durações suportadas pelo provider.
 * Algoritmo guloso: pega a maior duração que cabe, repete. Se sobrar resíduo
 * menor que a menor duração, adiciona a menor (overshoot aceitável).
 *
 * Ex Kling [5,10]:
 *   target 15 → [10, 5]            actual 15
 *   target 20 → [10, 10]           actual 20
 *   target 30 → [10, 10, 10]       actual 30
 *
 * Ex Veo [4,6,8]:
 *   target 8  → [8]                actual 8
 *   target 15 → [8, 6, 4]          actual 18 (overshoot +3)
 *   target 20 → [8, 8, 4]          actual 20
 *   target 30 → [8, 8, 8, 6]       actual 30
 */
function computeChainParts(target: number, supportedDurations: number[]): {
  parts:        number[]
  actualTarget: number
} {
  if (supportedDurations.length === 0) return { parts: [], actualTarget: 0 }
  const sortedDesc = [...supportedDurations].sort((a, b) => b - a)
  const smallest   = sortedDesc[sortedDesc.length - 1]
  const parts: number[] = []
  let remaining = target
  while (remaining > 0) {
    // Encontra a maior duração que cabe no que resta
    const fitting = sortedDesc.find(d => d <= remaining)
    const slice   = fitting ?? smallest // se nada cabe, pega a menor e aceita overshoot
    parts.push(slice)
    remaining -= slice
    // Safety: evita loop infinito se algo der errado
    if (parts.length > 10) break
  }
  return { parts, actualTarget: parts.reduce((s, p) => s + p, 0) }
}
