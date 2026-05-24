import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'
import { CreativeService, CreateBriefingDto, CreativeProduct } from '../creative/creative.service'
import { CreativeVideoPipelineService } from '../creative/creative-video-pipeline.service'
import { concatVideos } from '../../common/ffmpeg'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp') as typeof import('sharp')

const CREATIVE_BUCKET = 'creative'
const PUBLIC_BUCKET   = 'storefront-assets'

export interface StartReelDto {
  /** products.id do catálogo do SaaS — pra linkar/dedupe o creative_product. */
  catalog_product_id?: string
  product_title?:      string
  /** Foto real do produto (https). Vira o 1º quadro no Modo A / semente no Modo B. */
  product_photo_url:   string
  category?:           string
  /** product_photo = anima a foto real; ai_scene = gera uma cena por IA e anima. */
  mode:                'product_photo' | 'ai_scene'
  /** Prompt de movimento/estilo do vídeo (vem do Active, montado pelo estilo escolhido). */
  prompt:              string
  /** Modo B: descrição da cena pra IA compor (mantendo o produto). */
  scene_prompt?:       string
  aspect_ratio?:       '1:1' | '16:9' | '9:16'
  duration_seconds?:   number
  model_name?:         string
  camera_motion?:      'dolly-in' | 'dolly-out' | 'pan-left' | 'pan-right' | 'tilt-up' | 'tilt-down' | 'orbit' | 'static'
  max_cost_usd?:       number
}

export interface ReelStatus {
  status:      string
  /** URL https pública estável do mp4 final (quando completed). */
  public_url:  string | null
  /** Signed URL do vídeo (1h) — útil pra preview enquanto o público propaga. */
  preview_url: string | null
  error:       string | null
}

/**
 * Orquestração interna pro Social AI Studio do Active gerar REELS reusando o
 * pipeline de vídeo do `creative` (Kling/Veo/Sora). Esconde do Active toda a
 * máquina de creative_products / creative_briefings / creative_images.
 *
 * Fluxo:
 *   1. ensure creative_product (dedupe por catalog product_id)
 *   2. createBriefing (9:16, video_prompts=[prompt])
 *   3. resolve a imagem-semente:
 *        Modo A → baixa a foto real do produto
 *        Modo B → LlmService.generateImage(sourceImageUrl=foto) compõe uma cena
 *   4. registra a semente como creative_images (status approved) → source_image_id
 *   5. createChainedJobFromImage (image-to-video) → job_id
 *   6. getReel: quando completed, espelha o mp4 master do bucket privado
 *      `creative` pro público `storefront-assets` (URL estável pro Instagram)
 *
 * Consumido por /internal/creative/social-video (guard X-Internal-Key).
 */
@Injectable()
export class SocialVideoBridgeService {
  private readonly logger = new Logger(SocialVideoBridgeService.name)

  constructor(
    private readonly llm:      LlmService,
    private readonly creative: CreativeService,
    private readonly videos:   CreativeVideoPipelineService,
  ) {}

  async startReel(orgId: string, userId: string | null, dto: StartReelDto): Promise<{ job_id: string }> {
    if (!dto.product_photo_url?.trim()) throw new BadRequestException('product_photo_url obrigatório')
    if (!dto.prompt?.trim())            throw new BadRequestException('prompt obrigatório')
    const uid = userId ?? null

    // 1. creative_product (find-or-create)
    const product = await this.ensureCreativeProduct(orgId, uid, dto)

    // 2. briefing 9:16 com o prompt do vídeo
    const briefing = await this.creative.createBriefing(orgId, product.id, {
      target_marketplace: 'mercado_livre',
      image_format:       '1200x1500',  // → aspect 9:16
      video_prompts:      [dto.prompt.trim()],
    } as CreateBriefingDto)

    // 3. semente (Modo A = foto real; Modo B = cena IA mantendo o produto)
    const seed = dto.mode === 'ai_scene'
      ? { buffer: await this.generateSceneImage(orgId, product.id, dto), label: 'Cena gerada por IA (Social AI)' }
      : { buffer: await this.downloadImage(dto.product_photo_url),       label: 'Foto do produto (Social AI)' }

    // 4. registra a semente como source image aprovada
    const sourceImageId = await this.registerSourceImage(orgId, product.id, briefing.id, seed.buffer, seed.label)

    // 5. job encadeado image-to-video
    const job = await this.videos.createChainedJobFromImage(orgId, (uid ?? null) as unknown as string, {
      product_id:              product.id,
      briefing_id:             briefing.id,
      source_image_id:         sourceImageId,
      target_duration_seconds: Math.max(5, Math.min(30, dto.duration_seconds ?? 10)),
      aspect_ratio:            dto.aspect_ratio ?? '9:16',
      model_name:              dto.model_name ?? 'kling-v2-6',
      camera_motion:           dto.camera_motion ?? 'dolly-in',
      prompt:                  dto.prompt.trim(),
      max_cost_usd:            dto.max_cost_usd,
    })

    this.logger.log(`[social-video] reel job ${job.id} (org=${orgId} mode=${dto.mode} product=${product.id})`)
    return { job_id: job.id }
  }

  async getReel(orgId: string, jobId: string): Promise<ReelStatus> {
    const job = await this.videos.getJob(orgId, jobId)
    if (job.status === 'failed' || job.status === 'cancelled') {
      return { status: 'failed', public_url: null, preview_url: null, error: job.error_message ?? `job ${job.status}` }
    }
    if (job.status !== 'completed') {
      return { status: job.status, public_url: null, preview_url: null, error: null }
    }
    const vids = await this.videos.listVideosByJob(orgId, jobId)
    // Reel final: master do chain; senão a parte ready/approved com vídeo.
    const ready =
      vids.find(v => v.is_chain_master && v.storage_path) ??
      vids.find(v => v.storage_path && (v.status === 'ready' || v.status === 'approved')) ??
      vids.find(v => v.storage_path)
    if (!ready?.storage_path) {
      // Job "completou" mas nenhuma parte gerou vídeo (ex: provider recusou a
      // imagem). Surface o erro real da parte em vez de "completed" vazio.
      const partErr = vids.find(v => v.error_message)?.error_message
      return { status: 'failed', public_url: null, preview_url: null, error: partErr ?? 'vídeo não foi gerado' }
    }
    const publicUrl = await this.mirrorToPublic(orgId, ready.id, ready.storage_path).catch(err => {
      this.logger.warn(`[social-video] mirror falhou job=${jobId}: ${(err as Error).message}`)
      return null
    })
    return {
      status:      'completed',
      public_url:  publicUrl,
      preview_url: ready.signed_video_url ?? null,
      error:       null,
    }
  }

  // ── E3: Reel multi-cena (várias fotos → 1 vídeo concatenado) ──────────────

  /** Gera 1 clipe por foto escolhida (2-4) e devolve os job_ids; o Active faz
   *  poll de todos e, quando prontos, getMultiSceneReel concatena num reel só. */
  async startMultiSceneReel(
    orgId: string,
    userId: string | null,
    dto: StartReelDto & { photo_urls: string[] },
  ): Promise<{ job_ids: string[] }> {
    const photos = (dto.photo_urls ?? []).filter(u => u?.trim()).slice(0, 4)
    if (photos.length < 2) throw new BadRequestException('multi-cena precisa de 2+ fotos')
    if (!dto.prompt?.trim()) throw new BadRequestException('prompt obrigatório')
    const uid = userId ?? null

    const product = await this.ensureCreativeProduct(orgId, uid, { ...dto, product_photo_url: photos[0] })
    const briefing = await this.creative.createBriefing(orgId, product.id, {
      target_marketplace: 'mercado_livre',
      image_format:       '1200x1500',
      video_prompts:      [dto.prompt.trim()],
    } as CreateBriefingDto)

    const perScene = Math.max(5, Math.min(10, dto.duration_seconds ?? 5))
    const jobIds: string[] = []
    for (let i = 0; i < photos.length; i++) {
      const buffer = await this.downloadImage(photos[i])
      const sourceImageId = await this.registerSourceImage(orgId, product.id, briefing.id, buffer, `Cena ${i + 1} (Social AI)`)
      const job = await this.videos.createChainedJobFromImage(orgId, (uid ?? null) as unknown as string, {
        product_id:              product.id,
        briefing_id:             briefing.id,
        source_image_id:         sourceImageId,
        target_duration_seconds: perScene,
        aspect_ratio:            dto.aspect_ratio ?? '9:16',
        model_name:              dto.model_name ?? 'kling-v2-6',
        camera_motion:           dto.camera_motion ?? 'dolly-in',
        prompt:                  dto.prompt.trim(),
        max_cost_usd:            dto.max_cost_usd,
      })
      jobIds.push(job.id)
    }
    this.logger.log(`[social-video] multi-cena ${jobIds.length} jobs (org=${orgId} product=${product.id})`)
    return { job_ids: jobIds }
  }

  /** Status do multi-cena: quando TODOS os jobs completam, baixa os clipes e
   *  concatena (ffmpeg) num reel único → URL pública. */
  async getMultiSceneReel(orgId: string, jobIds: string[]): Promise<ReelStatus> {
    if (!jobIds.length) return { status: 'failed', public_url: null, preview_url: null, error: 'sem jobs' }
    const readyPaths: string[] = []
    for (const jobId of jobIds) {
      const job = await this.videos.getJob(orgId, jobId)
      if (job.status === 'failed' || job.status === 'cancelled') {
        return { status: 'failed', public_url: null, preview_url: null, error: job.error_message ?? `job ${job.status}` }
      }
      if (job.status !== 'completed') {
        return { status: job.status, public_url: null, preview_url: null, error: null }
      }
      const path = await this.findReadyStoragePath(orgId, jobId)
      if (!path) {
        const vids = await this.videos.listVideosByJob(orgId, jobId)
        const partErr = vids.find(v => v.error_message)?.error_message
        return { status: 'failed', public_url: null, preview_url: null, error: partErr ?? 'cena sem vídeo' }
      }
      readyPaths.push(path)
    }
    // Todos prontos → baixa cada clipe e concatena
    try {
      const buffers: Buffer[] = []
      for (const p of readyPaths) {
        const { data: blob, error } = await supabaseAdmin.storage.from(CREATIVE_BUCKET).download(p)
        if (error || !blob) throw new Error(`download cena: ${error?.message}`)
        buffers.push(Buffer.from(await blob.arrayBuffer()))
      }
      const masterBuffer = await concatVideos(buffers)
      const pubPath = `${orgId}/reels/multi-${jobIds[0]}.mp4`
      const { error: upErr } = await supabaseAdmin.storage
        .from(PUBLIC_BUCKET)
        .upload(pubPath, masterBuffer, { contentType: 'video/mp4', upsert: true, cacheControl: '3600' })
      if (upErr) throw new Error(`upload concat: ${upErr.message}`)
      const publicUrl = supabaseAdmin.storage.from(PUBLIC_BUCKET).getPublicUrl(pubPath).data.publicUrl
      return { status: 'completed', public_url: publicUrl, preview_url: null, error: null }
    } catch (e) {
      this.logger.warn(`[social-video] concat multi falhou: ${(e as Error).message}`)
      return { status: 'failed', public_url: null, preview_url: null, error: `falha ao juntar cenas: ${(e as Error).message}` }
    }
  }

  /** storage_path do vídeo final de um job (master do chain ou parte ready). */
  private async findReadyStoragePath(orgId: string, jobId: string): Promise<string | null> {
    const vids = await this.videos.listVideosByJob(orgId, jobId)
    const ready =
      vids.find(v => v.is_chain_master && v.storage_path) ??
      vids.find(v => v.storage_path && (v.status === 'ready' || v.status === 'approved')) ??
      vids.find(v => v.storage_path)
    return ready?.storage_path ?? null
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Acha um creative_product já ligado a esse produto do catálogo, ou cria. */
  private async ensureCreativeProduct(
    orgId: string, userId: string | null, dto: StartReelDto,
  ): Promise<CreativeProduct> {
    if (dto.catalog_product_id) {
      const { data } = await supabaseAdmin
        .from('creative_products')
        .select('*')
        .eq('organization_id', orgId)
        .eq('product_id', dto.catalog_product_id)
        .neq('status', 'archived')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (data) return data as CreativeProduct
    }

    // Sobe a foto real pro bucket privado `creative` (vira main_image)
    const buffer      = await this.downloadImage(dto.product_photo_url)
    const storagePath = `${orgId}/social/${randomUUID()}.jpg`
    const { error: upErr } = await supabaseAdmin.storage
      .from(CREATIVE_BUCKET)
      .upload(storagePath, buffer, { contentType: 'image/jpeg', upsert: true, cacheControl: '3600' })
    if (upErr) throw new BadRequestException(`upload foto produto: ${upErr.message}`)
    const signed = await this.creative.signImage(storagePath, 3600).catch(() => dto.product_photo_url)

    // user_id é nullable (FK auth.users ON DELETE SET NULL). A ponte interna
    // não tem usuário do SaaS → passa null (não 'social-bridge', que não é uuid).
    return this.creative.createProduct(orgId, (userId ?? null) as unknown as string, {
      name:                    (dto.product_title ?? 'Produto').slice(0, 200),
      category:                (dto.category ?? 'Geral').slice(0, 120),
      main_image_url:          signed,
      main_image_storage_path: storagePath,
      product_id:              dto.catalog_product_id,
    })
  }

  /** Modo B — compõe uma cena (9:16) mantendo o produto real via Nano Banana. */
  private async generateSceneImage(orgId: string, productId: string, dto: StartReelDto): Promise<Buffer> {
    const scenePrompt = (dto.scene_prompt?.trim() || dto.prompt.trim())
    const out = await this.llm.generateImage({
      orgId,
      feature:        'creative_image',
      prompt:         scenePrompt,
      sourceImageUrl: dto.product_photo_url,
      format:         'story',  // 9:16
      n:              1,
      creative:       { productId, operation: 'social_reel_scene' },
    })
    const img = out.images[0]
    if (!img) throw new BadRequestException('IA não retornou imagem de cena')
    if (img.b64) return Buffer.from(img.b64, 'base64')
    if (img.url) return this.downloadImage(img.url)
    throw new BadRequestException('imagem de cena sem url/base64')
  }

  /** Registra um buffer já pronto como creative_images status=approved (source). */
  private async registerSourceImage(
    orgId: string, productId: string, briefingId: string, buffer: Buffer, label: string,
  ): Promise<string> {
    const nowIso = new Date().toISOString()
    const { data: job, error: jobErr } = await supabaseAdmin
      .from('creative_image_jobs')
      .insert({
        organization_id: orgId,
        product_id:      productId,
        briefing_id:     briefingId,
        status:          'completed',
        requested_count: 1,
        completed_count: 1,
        approved_count:  1,
        max_cost_usd:    0,
        total_cost_usd:  0,
        prompts_metadata: { source: 'social_video_bridge' },
        started_at:      nowIso,
        completed_at:    nowIso,
      })
      .select('id')
      .single()
    if (jobErr || !job) throw new BadRequestException(`registerSourceImage.job: ${jobErr?.message}`)

    const imageId     = randomUUID()
    const storagePath = `${orgId}/${productId}/images/${imageId}.jpg`
    const normalized  = await this.normalizeSeed(buffer)
    const { error: upErr } = await supabaseAdmin.storage
      .from(CREATIVE_BUCKET)
      .upload(storagePath, normalized, { contentType: 'image/jpeg', upsert: true, cacheControl: '3600' })
    if (upErr) throw new BadRequestException(`registerSourceImage.upload: ${upErr.message}`)

    const { error: insErr } = await supabaseAdmin
      .from('creative_images')
      .insert({
        id:                  imageId,
        job_id:              (job as { id: string }).id,
        product_id:          productId,
        organization_id:     orgId,
        position:            1,
        prompt_text:         label,
        status:              'approved',
        storage_path:        storagePath,
        approved_at:         nowIso,
        generation_metadata: { source: 'social_video_bridge' },
      })
    if (insErr) throw new BadRequestException(`registerSourceImage.insert: ${insErr.message}`)
    return imageId
  }

  /** Copia o mp4 master do bucket privado pro público (URL https estável). */
  private async mirrorToPublic(orgId: string, masterId: string, storagePath: string): Promise<string> {
    const pubPath = `${orgId}/reels/${masterId}.mp4`
    // Idempotente: se já existe, só devolve a URL pública.
    const { data: blob, error: dlErr } = await supabaseAdmin.storage
      .from(CREATIVE_BUCKET)
      .download(storagePath)
    if (dlErr || !blob) throw new BadRequestException(`download master: ${dlErr?.message}`)
    const buf = Buffer.from(await blob.arrayBuffer())
    const { error: upErr } = await supabaseAdmin.storage
      .from(PUBLIC_BUCKET)
      .upload(pubPath, buf, { contentType: 'video/mp4', upsert: true, cacheControl: '3600' })
    if (upErr) throw new BadRequestException(`upload público: ${upErr.message}`)
    return supabaseAdmin.storage.from(PUBLIC_BUCKET).getPublicUrl(pubPath).data.publicUrl
  }

  /**
   * Normaliza a foto-semente pra um quadro 9:16 1080x1920 (fundo branco).
   * Fotos de dropship vêm pequenas/quadradas e o Kling recusa com
   * "Image pixel is invalid" — isso garante resolução + proporção aceitas
   * e deixa o produto centrado.
   */
  private async normalizeSeed(buffer: Buffer): Promise<Buffer> {
    try {
      // `cover`: preenche o quadro 9:16 inteiro (corta as sobras) — sem barras
      // brancas. É o que dá o reel em tela cheia (vertical) que o IG/TikTok
      // esperam. Produto fica centrado (`position: centre`).
      return await sharp(buffer)
        .resize(1080, 1920, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 90 })
        .toBuffer()
    } catch (e) {
      this.logger.warn(`[social-video] normalizeSeed falhou, usa original: ${(e as Error).message}`)
      return buffer
    }
  }

  private async downloadImage(url: string): Promise<Buffer> {
    // Fotos de dropship às vezes têm espaço na URL → encode (sem re-encodar %xx).
    const safe = /%[0-9a-f]{2}/i.test(url) ? url : url.replace(/ /g, '%20')
    const res = await fetch(safe)
    if (!res.ok) throw new BadRequestException(`download imagem falhou (HTTP ${res.status})`)
    return Buffer.from(await res.arrayBuffer())
  }
}
