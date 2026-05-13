/**
 * FlowProvider — Google Veo 3.1 via Gemini API (AI Studio).
 *
 * Endpoint: https://generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning
 * Auth:     header `x-goog-api-key: <GEMINI_API_KEY>`
 *
 * Pegar API key em https://aistudio.google.com/apikey
 *
 * Models suportados (maio/2026):
 *   - veo-3.1-fast-generate-preview   ⭐ default (rápido, $0.15/s, áudio nativo)
 *   - veo-3.1-generate-preview        (premium, $0.40/s, áudio nativo)
 *
 * Vantagens vs Kling:
 *   - Áudio nativo em todos os modelos
 *   - Suporta `lastFrame` (encadeamento "ground truth" — vídeo termina onde
 *     você diz)
 *   - Resolução até 1080p
 *   - Durations 4 / 6 / 8s (mais granular que Kling 5/10)
 *
 * Limitações:
 *   - Imagem precisa virar base64 (não aceita URL direto)
 *   - URLs de download expiram em ~24h e exigem API key
 */

import { Injectable, BadRequestException, HttpException, HttpStatus, Logger } from '@nestjs/common'
import axios, { AxiosError } from 'axios'
import { retryWithBackoff } from '../../../common/retry'
import type {
  VideoProvider,
  VideoModelOption,
  VideoSubmitInput,
  VideoTaskStatus,
} from './video-provider.interface'

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

@Injectable()
export class FlowProvider implements VideoProvider {
  readonly key = 'flow' as const
  private readonly logger = new Logger(FlowProvider.name)

  /** Pricing API real (Veo 3.1 — confirmar quando bater fatura). */
  private static readonly MODELS: VideoModelOption[] = [
    {
      id:                    'veo-3.1-fast-generate-preview',
      label:                 'Veo 3.1 Fast',
      badge:                 'Google · rápido · áudio',
      provider:              'flow',
      quality:               'fast',
      hasAudio:              true,
      supportedDurations:    [4, 6, 8],
      supportsTailImage:     true,
      supportsCameraControl: false,
      pricing:               { 4: 0.60, 6: 0.90, 8: 1.20 },
    },
    {
      id:                    'veo-3.1-generate-preview',
      label:                 'Veo 3.1 Standard',
      badge:                 'Google · premium · áudio',
      provider:              'flow',
      quality:               'premium',
      hasAudio:              true,
      supportedDurations:    [4, 6, 8],
      supportsTailImage:     true,
      supportsCameraControl: false,
      pricing:               { 4: 1.60, 6: 2.40, 8: 3.20 },
    },
  ]

  listModels(): VideoModelOption[] {
    return this.isConfigured() ? FlowProvider.MODELS : []
  }

  isConfigured(): boolean {
    return Boolean(process.env.GEMINI_API_KEY)
  }

  async submit(input: VideoSubmitInput): Promise<{ taskId: string }> {
    const apiKey = this.getApiKey()

    // Validate duration
    const model = FlowProvider.MODELS.find(m => m.id === input.modelId)
    if (!model) {
      throw new BadRequestException(`Modelo Veo desconhecido: ${input.modelId}`)
    }
    if (!model.supportedDurations.includes(input.duration)) {
      throw new BadRequestException(
        `Veo ${model.id} suporta apenas durações ${model.supportedDurations.join('/')}s — recebido ${input.duration}s`,
      )
    }

    // Veo requer imagem em base64 — não aceita URL.
    const startImage = await this.fetchImageBase64(input.imageUrl)

    const instance: Record<string, unknown> = {
      prompt: input.prompt,
      image: {
        bytesBase64Encoded: startImage.data,
        mimeType:           startImage.mimeType,
      },
    }
    if (input.lastFrameUrl) {
      const lastFrameImage = await this.fetchImageBase64(input.lastFrameUrl)
      instance.lastFrame = {
        bytesBase64Encoded: lastFrameImage.data,
        mimeType:           lastFrameImage.mimeType,
      }
    }

    const parameters: Record<string, unknown> = {
      durationSeconds: input.duration,
      aspectRatio:     input.aspectRatio,
      sampleCount:     1,
      personGeneration: 'allow_adult',
    }
    if (input.negativePrompt) {
      parameters.negativePrompt = input.negativePrompt
    }

    try {
      const res = await retryWithBackoff(
        () => axios.post<{ name?: string; error?: { message?: string } }>(
          `${GEMINI_API_BASE}/models/${encodeURIComponent(input.modelId)}:predictLongRunning`,
          { instances: [instance], parameters },
          {
            headers: {
              'x-goog-api-key': apiKey,
              'Content-Type':   'application/json',
            },
            timeout:          60_000,
            maxContentLength: 50 * 1024 * 1024,
            maxBodyLength:    50 * 1024 * 1024,
          },
        ),
        { maxRetries: 2, baseMs: 1500, label: 'veo.submit' },
      )

      const operationName = res.data?.name
      if (!operationName) {
        throw new HttpException(
          `Veo submit sem operation name. Resposta: ${JSON.stringify(res.data)}`,
          HttpStatus.BAD_GATEWAY,
        )
      }
      this.logger.log(`[flow.submit] op=${operationName} model=${input.modelId} dur=${input.duration}s`)
      return { taskId: operationName }
    } catch (e: unknown) {
      if (axios.isAxiosError(e)) {
        const ax = e as AxiosError<{ error?: { message?: string; status?: string } }>
        const msg = ax.response?.data?.error?.message ?? ax.message
        throw new HttpException(`Veo submit falhou: ${msg}`, HttpStatus.BAD_GATEWAY)
      }
      throw e
    }
  }

  async pollStatus(taskId: string): Promise<VideoTaskStatus> {
    const apiKey = this.getApiKey()
    try {
      const res = await retryWithBackoff(
        () => axios.get<{
          name:     string
          done?:    boolean
          error?:   { message?: string; code?: number }
          response?: {
            // Forma documentada em mai/2026:
            generateVideoResponse?: {
              generatedSamples?: Array<{
                video?:    { uri?: string }
                duration?: string | number
              }>
            }
            // Forma legada (alguns SDKs):
            videos?: Array<{
              uri?:    string
              gcsUri?: string
            }>
          }
        }>(
          // taskId já vem como path completo "models/.../operations/...".
          `${GEMINI_API_BASE}/${taskId.replace(/^\/+/, '')}`,
          {
            headers: { 'x-goog-api-key': apiKey },
            timeout: 15_000,
          },
        ),
        { maxRetries: 2, baseMs: 1000, label: 'veo.poll' },
      )

      const data = res.data

      if (data.error) {
        return {
          taskId,
          status:    'failed',
          statusMsg: data.error.message ?? `Veo error code=${data.error.code}`,
        }
      }
      if (!data.done) {
        return { taskId, status: 'processing' }
      }

      const samples = data.response?.generateVideoResponse?.generatedSamples
      const videos  = data.response?.videos
      const videoUri = samples?.[0]?.video?.uri ?? videos?.[0]?.uri ?? videos?.[0]?.gcsUri

      if (!videoUri) {
        return {
          taskId,
          status:    'failed',
          statusMsg: `Veo done=true mas sem URI de vídeo. data=${JSON.stringify(data.response).slice(0, 300)}`,
        }
      }

      const durRaw = samples?.[0]?.duration
      const durationSec = typeof durRaw === 'number'
        ? durRaw
        : typeof durRaw === 'string'
          ? Number(durRaw.replace(/[^\d.]/g, '')) || undefined
          : undefined

      return {
        taskId,
        status:    'succeed',
        videoUrl:  videoUri,
        durationSec,
      }
    } catch (e: unknown) {
      if (axios.isAxiosError(e)) {
        const ax = e as AxiosError<{ error?: { message?: string } }>
        const msg = ax.response?.data?.error?.message ?? ax.message
        throw new HttpException(`Veo poll falhou: ${msg}`, HttpStatus.BAD_GATEWAY)
      }
      throw e
    }
  }

  async download(url: string): Promise<Buffer> {
    const apiKey = this.getApiKey()
    // URIs do Veo dentro do generativelanguage.googleapis.com exigem auth.
    // gs:// URIs precisam de service account — não suportado nessa via.
    if (url.startsWith('gs://')) {
      throw new BadRequestException(
        'Veo retornou gs:// URI — requer Vertex AI (service account). Configurar GOOGLE_VERTEX_* ou usar Gemini API path.',
      )
    }
    const res = await axios.get<ArrayBuffer>(url, {
      headers:          { 'x-goog-api-key': apiKey },
      responseType:     'arraybuffer',
      timeout:          120_000,
      maxContentLength: 200 * 1024 * 1024,
    })
    return Buffer.from(res.data)
  }

  estimateCost(modelId: string, duration: number): number {
    const model = FlowProvider.MODELS.find(m => m.id === modelId)
    return model?.pricing[duration] ?? 0
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private getApiKey(): string {
    const key = process.env.GEMINI_API_KEY
    if (!key) {
      throw new BadRequestException(
        'GEMINI_API_KEY não configurada. Pegar em https://aistudio.google.com/apikey e setar no Railway.',
      )
    }
    return key
  }

  private async fetchImageBase64(url: string): Promise<{ data: string; mimeType: string }> {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType:     'arraybuffer',
      timeout:          30_000,
      maxContentLength: 20 * 1024 * 1024,
    })
    const contentType = (res.headers['content-type'] as string | undefined)?.split(';')[0]?.trim() ?? 'image/png'
    const data = Buffer.from(res.data).toString('base64')
    return { data, mimeType: contentType }
  }
}
