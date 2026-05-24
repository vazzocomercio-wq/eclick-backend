/**
 * SoraProvider — OpenAI Sora 2 / Sora 2 Pro via API REST.
 *
 * Endpoint: https://api.openai.com/v1/videos
 * Auth:     header `Authorization: Bearer <OPENAI_API_KEY>`
 *
 * REUSA a mesma OPENAI_API_KEY já configurada pra geração de imagens
 * (gpt-image-1, gpt-image-1-mini):
 *   1. api_credentials per-org (provider='openai', key_name='OPENAI_API_KEY')
 *   2. api_credentials global (orgId=null)
 *   3. env OPENAI_API_KEY_DEFAULT
 *
 * Models suportados (maio/2026):
 *   - sora-2        ⭐ default (rápido, $0.10/s, áudio nativo)
 *   - sora-2-pro    (premium, $0.30/s 720p / $0.50/s 1080p, melhor qualidade)
 *
 * Vantagens vs Kling/Veo:
 *   - 9:16 nativo: o param `size` é respeitado (não herda da source image)
 *   - Modelo "TikTok-quality" — é o mesmo que roda no TikTok Symphony Studio
 *   - Áudio nativo em todos os modelos
 *
 * Limitações:
 *   - Durações fixas: 4, 8 ou 12 segundos
 *   - Image2video: imagem é referência, mas Sora não obriga match exato de
 *     dimensões — adapter ainda recorta pro aspect alvo pra melhor resultado.
 */

import { Injectable, BadRequestException, HttpException, HttpStatus, Logger } from '@nestjs/common'
import axios, { AxiosError } from 'axios'
import * as FormData from 'form-data'
import { retryWithBackoff } from '../../../common/retry'
import { CredentialsService } from '../../credentials/credentials.service'
import type {
  VideoProvider,
  VideoModelOption,
  VideoSubmitInput,
  VideoTaskStatus,
  VideoCallContext,
  VideoAspectRatio,
} from './video-provider.interface'

const OPENAI_API_BASE = 'https://api.openai.com/v1'
const OPENAI_KEY_NAME = 'OPENAI_API_KEY'

type SoraModel = 'sora-2' | 'sora-2-pro'

/** Mapeia VideoAspectRatio pro size que a Sora aceita. sora-2 só faz 720p
 *  na fase atual; sora-2-pro também 1080p (mas usamos 720p universal pra
 *  garantir compatibilidade). */
const ASPECT_TO_SIZE: Record<VideoAspectRatio, string> = {
  '1:1':  '720x720',
  '16:9': '1280x720',
  '9:16': '720x1280',
}

@Injectable()
export class SoraProvider implements VideoProvider {
  readonly key = 'sora' as const
  private readonly logger = new Logger(SoraProvider.name)

  constructor(private readonly credentials: CredentialsService) {}

  /** Pricing aproximado por segundo (referência maio/2026 — pode mudar). */
  private static readonly MODELS: VideoModelOption[] = [
    {
      id:                    'sora-2',
      label:                 'Sora 2',
      badge:                 'OpenAI · TikTok engine · áudio',
      provider:              'sora',
      quality:               'standard',
      hasAudio:              true,
      supportedDurations:    [4, 8, 12],
      supportsTailImage:     false,
      supportsCameraControl: false,
      pricing:               { 4: 0.40, 8: 0.80, 12: 1.20 }, // $0.10/s
    },
    {
      id:                    'sora-2-pro',
      label:                 'Sora 2 Pro',
      badge:                 'OpenAI · premium · áudio',
      provider:              'sora',
      quality:               'premium',
      hasAudio:              true,
      supportedDurations:    [4, 8, 12],
      supportsTailImage:     false,
      supportsCameraControl: false,
      pricing:               { 4: 1.20, 8: 2.40, 12: 3.60 }, // $0.30/s 720p
    },
  ]

  listModels(): VideoModelOption[] {
    // Sempre lista — resolução de chave é async via DB.
    // Erros aparecem no submit com mensagem clara se key não estiver setada.
    return SoraProvider.MODELS
  }

  isConfigured(): boolean {
    // Confiamos no resolveApiKey async.
    return true
  }

  async submit(input: VideoSubmitInput): Promise<{ taskId: string }> {
    const apiKey = await this.resolveApiKey(input.orgId)

    // Valida modelo + duração
    const model = SoraProvider.MODELS.find(m => m.id === input.modelId)
    if (!model) {
      throw new BadRequestException(`Modelo Sora desconhecido: ${input.modelId}`)
    }
    if (!model.supportedDurations.includes(input.duration)) {
      throw new BadRequestException(
        `Sora ${model.id} suporta apenas durações ${model.supportedDurations.join('/')}s — recebido ${input.duration}s`,
      )
    }

    const size = ASPECT_TO_SIZE[input.aspectRatio]
    if (!size) {
      throw new BadRequestException(`Aspect ${input.aspectRatio} não suportado pelo Sora`)
    }

    // Download da imagem-base pra mandar como multipart input_reference
    const imageRes = await axios.get<ArrayBuffer>(input.imageUrl, {
      responseType:     'arraybuffer',
      timeout:          30_000,
      maxContentLength: 20 * 1024 * 1024,
    })
    const imageBuffer = Buffer.from(imageRes.data)
    const contentType = (imageRes.headers['content-type'] as string | undefined)?.split(';')[0]?.trim() ?? 'image/jpeg'
    const ext = contentType === 'image/png' ? 'png' : 'jpg'

    // Monta multipart form
    const form = new FormData()
    form.append('model',           input.modelId as SoraModel)
    form.append('prompt',          input.prompt.slice(0, 4000))
    form.append('seconds',         String(input.duration))
    form.append('size',            size)
    form.append('input_reference', imageBuffer, { filename: `source.${ext}`, contentType })

    try {
      const res = await retryWithBackoff(
        () => axios.post<{
          id?:     string
          status?: string
          error?:  { message?: string; code?: string }
        }>(
          `${OPENAI_API_BASE}/videos`,
          form,
          {
            headers: {
              ...form.getHeaders(),
              'Authorization': `Bearer ${apiKey}`,
            },
            timeout:          120_000,
            maxContentLength: 50 * 1024 * 1024,
            maxBodyLength:    50 * 1024 * 1024,
          },
        ),
        { maxRetries: 2, baseMs: 1500, label: 'sora.submit' },
      )

      const videoId = res.data?.id
      if (!videoId) {
        throw new HttpException(
          `Sora submit sem id. Resposta: ${JSON.stringify(res.data)}`,
          HttpStatus.BAD_GATEWAY,
        )
      }
      this.logger.log(`[sora.submit] id=${videoId} model=${input.modelId} size=${size} dur=${input.duration}s`)
      return { taskId: videoId }
    } catch (e: unknown) {
      if (axios.isAxiosError(e)) {
        const ax = e as AxiosError<{ error?: { message?: string; code?: string } }>
        const msg = ax.response?.data?.error?.message ?? ax.message
        throw new HttpException(`Sora submit falhou: ${msg}`, HttpStatus.BAD_GATEWAY)
      }
      throw e
    }
  }

  async pollStatus(taskId: string, ctx?: VideoCallContext): Promise<VideoTaskStatus> {
    const apiKey = await this.resolveApiKey(ctx?.orgId)
    try {
      const res = await retryWithBackoff(
        () => axios.get<{
          id:           string
          status:       'queued' | 'in_progress' | 'completed' | 'failed'
          progress?:    number
          error?:       { message?: string; code?: string }
          // Algumas versões retornam content_url direto, outras exigem /content endpoint
          content_url?: string
        }>(
          `${OPENAI_API_BASE}/videos/${encodeURIComponent(taskId)}`,
          {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            timeout: 15_000,
          },
        ),
        { maxRetries: 2, baseMs: 1000, label: 'sora.poll' },
      )

      const data = res.data

      if (data.status === 'failed') {
        return {
          taskId,
          status:    'failed',
          statusMsg: data.error?.message ?? `Sora failed (code=${data.error?.code ?? '?'})`,
        }
      }
      if (data.status === 'queued') {
        return { taskId, status: 'submitted' }
      }
      if (data.status === 'in_progress') {
        return { taskId, status: 'processing' }
      }
      if (data.status === 'completed') {
        // URL pra download — se content_url não vier explicito, monta a partir do id
        const videoUrl = data.content_url ?? `${OPENAI_API_BASE}/videos/${encodeURIComponent(taskId)}/content`
        return { taskId, status: 'succeed', videoUrl }
      }
      return { taskId, status: 'processing' }
    } catch (e: unknown) {
      if (axios.isAxiosError(e)) {
        const ax = e as AxiosError<{ error?: { message?: string } }>
        const msg = ax.response?.data?.error?.message ?? ax.message
        throw new HttpException(`Sora poll falhou: ${msg}`, HttpStatus.BAD_GATEWAY)
      }
      throw e
    }
  }

  async download(url: string, ctx?: VideoCallContext): Promise<Buffer> {
    const apiKey = await this.resolveApiKey(ctx?.orgId)
    // URLs do Sora exigem auth Bearer
    const res = await axios.get<ArrayBuffer>(url, {
      headers:          { 'Authorization': `Bearer ${apiKey}` },
      responseType:     'arraybuffer',
      timeout:          120_000,
      maxContentLength: 200 * 1024 * 1024,
    })
    return Buffer.from(res.data)
  }

  estimateCost(modelId: string, duration: number): number {
    const model = SoraProvider.MODELS.find(m => m.id === modelId)
    return model?.pricing[duration] ?? 0
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Resolve OPENAI_API_KEY na mesma ordem que o LlmService usa pra gpt-image-1:
   *   1. api_credentials per-org (provider='openai', key_name='OPENAI_API_KEY')
   *   2. api_credentials global (orgId=null)
   *   3. env OPENAI_API_KEY_DEFAULT
   *
   * REUSA a mesma key já configurada pra imagens — zero setup adicional.
   */
  private async resolveApiKey(orgId?: string): Promise<string> {
    // BYOK: chave da org → (platform: matriz → env OPENAI_API_KEY_DEFAULT) /
    // (own: bloqueia com 402).
    return this.credentials.resolveAiKey(orgId ?? null, 'openai', OPENAI_KEY_NAME, {
      platformEnvFallback: process.env.OPENAI_API_KEY_DEFAULT ?? process.env.OPENAI_API_KEY ?? null,
    })
  }
}
