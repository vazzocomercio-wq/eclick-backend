import { Injectable, Logger, BadRequestException, HttpException, HttpStatus } from '@nestjs/common'
import { createHmac } from 'node:crypto'
import axios, { AxiosError } from 'axios'
import { retryWithBackoff } from '../../common/retry'

/**
 * Kling AI client — image-to-video.
 *
 * Auth: JWT HS256 assinado com KLING_ACCESS_KEY (iss) + KLING_SECRET_KEY.
 * Cada request gera um JWT novo (TTL 30min).
 *
 * Fluxo async:
 *   1. POST /v1/videos/image2video → retorna task_id (status=submitted)
 *   2. Worker pollea GET /v1/videos/image2video/{task_id} a cada N segundos
 *   3. Quando task_status=succeed, baixa video_url e sobe pro Storage
 *
 * Endpoint regional: api-singapore.klingai.com (default global).
 *
 * Models válidos (maio/2026):
 *   kling-v2-1         5s  → $0.21    10s  → $0.42   (std default)
 *   kling-v2-1-master  5s  → $0.42    10s  → $0.84   (premium)
 *   kling-v2-5         5s  → $0.30    10s  → $0.60   (std mais recente)
 *   kling-v2-6         5s  → $0.40    10s  → $0.80   (NOVO 2026 — áudio nativo, default)
 *   kling-v1-6         5s  → $0.18    10s  → $0.36   (legacy, mais barato)
 *
 * Models antigos kling-v1-6-std / kling-v1-6-pro / kling-v2-master foram
 * descontinuados pela Kling em 2026 e retornam erro "model_name is invalid".
 */

const KLING_BASE = process.env.KLING_API_BASE ?? 'https://api-singapore.klingai.com'
const KLING_JWT_TTL_SECONDS = 30 * 60

export type KlingModel =
  | 'kling-v2-1'
  | 'kling-v2-1-master'
  | 'kling-v2-5'
  | 'kling-v2-6'
  | 'kling-v1-6'
export type KlingDuration = '5' | '10'
export type KlingAspectRatio = '1:1' | '16:9' | '9:16'
export type KlingMode = 'std' | 'pro'

/** Default sugerido: v2-6 com áudio nativo. */
export const KLING_DEFAULT_MODEL: KlingModel = 'kling-v2-6'
export const KLING_DEFAULT_DURATION: KlingDuration = '10'

const PRICING: Record<KlingModel, Record<KlingDuration, number>> = {
  'kling-v2-1':        { '5': 0.21, '10': 0.42 },
  'kling-v2-1-master': { '5': 0.42, '10': 0.84 },
  'kling-v2-5':        { '5': 0.30, '10': 0.60 },
  'kling-v2-6':        { '5': 0.40, '10': 0.80 },
  'kling-v1-6':        { '5': 0.18, '10': 0.36 },
}

/**
 * Quais modelos aceitam `camera_control`. Apenas v1.x (modo std) suporta.
 * Modelos v2.x retornam "Camera control is not supported by the current model"
 * — pra eles, o movimento de câmera deve vir DESCRITO no prompt.
 */
const MODELS_WITH_CAMERA_CONTROL: ReadonlySet<KlingModel> = new Set([
  'kling-v1-6',
])

export function modelSupportsCameraControl(model: KlingModel): boolean {
  return MODELS_WITH_CAMERA_CONTROL.has(model)
}

/** Catálogo público pra UI escolher modelo + duração. */
export const KLING_MODEL_OPTIONS: Array<{
  value:                  KlingModel
  label:                  string
  badge?:                 string
  hasAudio:               boolean
  supportsCameraControl:  boolean
  pricing:                { '5': number; '10': number }
}> = [
  { value: 'kling-v2-6',        label: 'Kling v2.6',        badge: 'Novo · com áudio', hasAudio: true,  supportsCameraControl: false, pricing: PRICING['kling-v2-6'] },
  { value: 'kling-v2-1-master', label: 'Kling v2.1 Master', badge: 'Premium',          hasAudio: false, supportsCameraControl: false, pricing: PRICING['kling-v2-1-master'] },
  { value: 'kling-v2-5',        label: 'Kling v2.5',                                   hasAudio: false, supportsCameraControl: false, pricing: PRICING['kling-v2-5'] },
  { value: 'kling-v2-1',        label: 'Kling v2.1',        badge: 'Padrão',           hasAudio: false, supportsCameraControl: false, pricing: PRICING['kling-v2-1'] },
  { value: 'kling-v1-6',        label: 'Kling v1.6',        badge: 'Econômico',        hasAudio: false, supportsCameraControl: true,  pricing: PRICING['kling-v1-6'] },
]

/** Controle de câmera — pra "câmera em direção ao produto" usar zoom positivo (zoom_in). */
export interface KlingCameraControl {
  type:   'simple' | 'down_back' | 'forward_up' | 'right_turn_forward' | 'left_turn_forward'
  /** Só quando type='simple'. Valores -10 a 10. */
  config?: Partial<{
    horizontal: number
    vertical:   number
    pan:        number
    tilt:       number
    roll:       number
    zoom:       number
  }>
}

export interface KlingSubmitInput {
  imageUrl:     string
  prompt:       string
  negativePrompt?: string
  duration:     KlingDuration
  aspectRatio:  KlingAspectRatio
  modelName:    KlingModel
  /** 0-1, padrão 0.5. Maior = mais fidelidade ao prompt. */
  cfgScale?:    number
  /** std (default) ou pro. Não aplica em v2-1-master nem v2-6 (sempre pro). */
  mode?:        KlingMode
  /** Camera control (movimento de câmera). Padrão: zoom_in suave. */
  cameraControl?: KlingCameraControl
}

export interface KlingTaskInfo {
  taskId:       string
  status:       'submitted' | 'processing' | 'succeed' | 'failed'
  statusMsg?:   string
  videos?:      Array<{ id: string; url: string; duration: string }>
}

@Injectable()
export class KlingClient {
  private readonly logger = new Logger(KlingClient.name)

  /** Loga + lança se as envs não estão setadas. Chamado lazy ao primeiro uso. */
  private getCredentials(): { accessKey: string; secretKey: string } {
    const accessKey = process.env.KLING_ACCESS_KEY
    const secretKey = process.env.KLING_SECRET_KEY
    if (!accessKey || !secretKey) {
      throw new BadRequestException(
        'Kling não configurado: setar KLING_ACCESS_KEY e KLING_SECRET_KEY no Railway.',
      )
    }
    return { accessKey, secretKey }
  }

  /** JWT HS256 — espec do Kling: iss=accessKey, exp=now+30min, nbf=now-5s. */
  private signJwt(): string {
    const { accessKey, secretKey } = this.getCredentials()
    const header  = { alg: 'HS256', typ: 'JWT' }
    const now     = Math.floor(Date.now() / 1000)
    const payload = { iss: accessKey, exp: now + KLING_JWT_TTL_SECONDS, nbf: now - 5 }

    const headerB64  = base64url(JSON.stringify(header))
    const payloadB64 = base64url(JSON.stringify(payload))
    const sig        = createHmac('sha256', secretKey)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url')
    return `${headerB64}.${payloadB64}.${sig}`
  }

  /** Submete um job image2video. Retorna task_id pra polling posterior. */
  async submitImage2Video(input: KlingSubmitInput): Promise<{ taskId: string }> {
    const jwt = this.signJwt()
    const body: Record<string, unknown> = {
      model_name:   input.modelName,
      image:        input.imageUrl,
      prompt:       input.prompt.slice(0, 2_500),
      duration:     input.duration,
      aspect_ratio: input.aspectRatio,
      cfg_scale:    input.cfgScale ?? 0.5,
    }
    if (input.negativePrompt) body.negative_prompt = input.negativePrompt

    // mode (std/pro): v2-1-master e v2-6 não aceitam — sempre pro internamente
    if (input.mode && input.modelName !== 'kling-v2-1-master' && input.modelName !== 'kling-v2-6') {
      body.mode = input.mode
    }

    // camera_control: apenas em modelos que suportam (v1.x std). Em v2.x o
    // parâmetro é rejeitado pela API ("Camera control is not supported by
    // the current model") — pra esses, motion vem descrito no prompt.
    if (modelSupportsCameraControl(input.modelName)) {
      const cam = input.cameraControl ?? {
        type:   'simple' as const,
        config: { zoom: 5 },
      }
      body.camera_control = {
        type:   cam.type,
        ...(cam.config && { config: cam.config }),
      }
    } else if (input.cameraControl) {
      this.logger.warn(
        `[kling.submit] camera_control solicitado mas modelo ${input.modelName} não suporta — ignorando. ` +
        `Garanta que o prompt descreve o movimento desejado.`,
      )
    }

    try {
      const res = await retryWithBackoff(
        () => axios.post<{
          code: number
          message?: string
          data?: { task_id: string; task_status: string; created_at: number }
        }>(
          `${KLING_BASE}/v1/videos/image2video`,
          body,
          {
            headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
            timeout: 30_000,
          },
        ),
        { maxRetries: 2, baseMs: 1500, label: 'kling.submit' },
      )
      if (res.data.code !== 0 || !res.data.data?.task_id) {
        throw new HttpException(
          `Kling submit retornou code=${res.data.code}: ${res.data.message ?? 'sem mensagem'}`,
          HttpStatus.BAD_GATEWAY,
        )
      }
      return { taskId: res.data.data.task_id }
    } catch (e: unknown) {
      if (axios.isAxiosError(e)) {
        const ax = e as AxiosError<{ message?: string; code?: number }>
        const msg = ax.response?.data?.message ?? ax.message
        throw new HttpException(`Kling submit falhou: ${msg}`, HttpStatus.BAD_GATEWAY)
      }
      throw e
    }
  }

  /** Pollea status. Retorna info estruturada. */
  async getTaskStatus(taskId: string): Promise<KlingTaskInfo> {
    const jwt = this.signJwt()
    try {
      const res = await retryWithBackoff(
        () => axios.get<{
          code: number
          message?: string
          data?: {
            task_id: string
            task_status: 'submitted' | 'processing' | 'succeed' | 'failed'
            task_status_msg?: string
            task_result?: {
              videos?: Array<{ id: string; url: string; duration: string }>
            }
          }
        }>(
          `${KLING_BASE}/v1/videos/image2video/${encodeURIComponent(taskId)}`,
          {
            headers: { 'Authorization': `Bearer ${jwt}` },
            timeout: 15_000,
          },
        ),
        { maxRetries: 2, baseMs: 1000, label: 'kling.poll' },
      )
      if (res.data.code !== 0 || !res.data.data) {
        throw new HttpException(
          `Kling poll retornou code=${res.data.code}: ${res.data.message ?? 'sem mensagem'}`,
          HttpStatus.BAD_GATEWAY,
        )
      }
      const d = res.data.data
      return {
        taskId:    d.task_id,
        status:    d.task_status,
        statusMsg: d.task_status_msg,
        videos:    d.task_result?.videos,
      }
    } catch (e: unknown) {
      if (axios.isAxiosError(e)) {
        const ax = e as AxiosError<{ message?: string }>
        const msg = ax.response?.data?.message ?? ax.message
        throw new HttpException(`Kling poll falhou: ${msg}`, HttpStatus.BAD_GATEWAY)
      }
      throw e
    }
  }

  /** Baixa o vídeo de uma URL (Kling expira em ~24h) — retorna Buffer. */
  async downloadVideo(url: string): Promise<Buffer> {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      maxContentLength: 200 * 1024 * 1024, // 200MB cap
    })
    return Buffer.from(res.data)
  }

  /** Calcula custo USD do vídeo gerado, baseado em modelo + duração. */
  estimateCost(model: KlingModel, duration: KlingDuration): number {
    return PRICING[model]?.[duration] ?? 0
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function base64url(input: string): string {
  return Buffer.from(input).toString('base64url')
}
