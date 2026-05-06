import { Injectable, Logger, BadRequestException, HttpException, HttpStatus } from '@nestjs/common'
import { createHmac } from 'node:crypto'
import axios, { AxiosError } from 'axios'

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
 * Pricing (em USD, atualizar quando Kling mudar):
 *   kling-v1-6-std    5s  → $0.21
 *   kling-v1-6-std   10s  → $0.42
 *   kling-v2-master   5s  → $0.42
 *   kling-v2-master  10s  → $0.84
 */

const KLING_BASE = process.env.KLING_API_BASE ?? 'https://api-singapore.klingai.com'
const KLING_JWT_TTL_SECONDS = 30 * 60

export type KlingModel = 'kling-v1-6-std' | 'kling-v1-6-pro' | 'kling-v2-master'
export type KlingDuration = '5' | '10'
export type KlingAspectRatio = '1:1' | '16:9' | '9:16'

const PRICING: Record<KlingModel, Record<KlingDuration, number>> = {
  'kling-v1-6-std':   { '5': 0.21, '10': 0.42 },
  'kling-v1-6-pro':   { '5': 0.49, '10': 0.98 },
  'kling-v2-master':  { '5': 0.42, '10': 0.84 },
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

    try {
      const res = await axios.post<{
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
      const res = await axios.get<{
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
