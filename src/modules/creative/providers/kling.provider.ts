/**
 * KlingProvider — adapta o KlingClient existente pra interface VideoProvider.
 *
 * Limitações Kling vs interface:
 *   - Não suporta tail_image nativamente → lastFrameUrl é ignorado
 *     (pipeline lida com encadeamento via ffmpeg externamente)
 *   - Duration limitada a 5 ou 10 segundos
 *   - Camera motion mapeada pra camera_control type+config nativos
 */

import { Injectable } from '@nestjs/common'
import {
  KlingClient,
  KLING_MODEL_OPTIONS,
  type KlingModel,
  type KlingDuration,
  type KlingAspectRatio,
  type KlingCameraControl,
} from '../kling.client'
import type {
  VideoProvider,
  VideoModelOption,
  VideoSubmitInput,
  VideoTaskStatus,
  VideoQuality,
} from './video-provider.interface'

@Injectable()
export class KlingProvider implements VideoProvider {
  readonly key = 'kling' as const

  constructor(private readonly client: KlingClient) {}

  listModels(): VideoModelOption[] {
    return KLING_MODEL_OPTIONS.map(m => ({
      id:                    m.value,
      label:                 m.label,
      badge:                 m.badge,
      provider:              'kling' as const,
      quality:               this.qualityOf(m.value),
      hasAudio:              m.hasAudio,
      supportedDurations:    [5, 10],
      supportsTailImage:     false,
      supportsCameraControl: m.supportsCameraControl,
      pricing:               { 5: m.pricing['5'], 10: m.pricing['10'] },
    }))
  }

  async submit(input: VideoSubmitInput): Promise<{ taskId: string }> {
    if (input.duration !== 5 && input.duration !== 10) {
      throw new Error(`Kling só suporta duration 5 ou 10s, recebido ${input.duration}`)
    }
    return this.client.submitImage2Video({
      imageUrl:       input.imageUrl,
      prompt:         input.prompt,
      negativePrompt: input.negativePrompt,
      duration:       String(input.duration) as KlingDuration,
      aspectRatio:    input.aspectRatio as KlingAspectRatio,
      modelName:      input.modelId as KlingModel,
      cfgScale:       input.cfgScale,
      cameraControl:  mapCameraMotion(input.cameraMotion),
    })
  }

  async pollStatus(taskId: string): Promise<VideoTaskStatus> {
    const info = await this.client.getTaskStatus(taskId)
    const firstVideo = info.videos?.[0]
    return {
      taskId:      info.taskId,
      status:      info.status,
      statusMsg:   info.statusMsg,
      videoUrl:    firstVideo?.url,
      durationSec: firstVideo ? Number(firstVideo.duration) || undefined : undefined,
    }
  }

  download(url: string): Promise<Buffer> {
    return this.client.downloadVideo(url)
  }

  estimateCost(modelId: string, duration: number): number {
    if (duration !== 5 && duration !== 10) return 0
    return this.client.estimateCost(modelId as KlingModel, String(duration) as KlingDuration)
  }

  isConfigured(): boolean {
    return Boolean(process.env.KLING_ACCESS_KEY && process.env.KLING_SECRET_KEY)
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private qualityOf(id: KlingModel): VideoQuality {
    switch (id) {
      case 'kling-v2-6':        return 'audio-native'
      case 'kling-v2-1-master': return 'premium'
      case 'kling-v2-5':        return 'standard'
      case 'kling-v2-1':        return 'standard'
      case 'kling-v1-6':        return 'economy'
    }
  }
}

/**
 * Mapeia VideoSubmitInput.cameraMotion pra Kling camera_control.
 * Default (sem motion declarado): dolly-in suave (zoom +5) — câmera em
 * direção ao produto.
 */
function mapCameraMotion(motion?: VideoSubmitInput['cameraMotion']): KlingCameraControl {
  if (!motion) return { type: 'simple', config: { zoom: 5 } }

  const i = clampN(motion.intensity ?? 0.5, 0, 1)
  const v = Math.round(i * 10)  // 0..10

  switch (motion.type) {
    case 'dolly-in':    return { type: 'simple', config: { zoom: v } }
    case 'dolly-out':   return { type: 'simple', config: { zoom: -v } }
    case 'pan-left':    return { type: 'simple', config: { horizontal: -v } }
    case 'pan-right':   return { type: 'simple', config: { horizontal: v } }
    case 'tilt-up':     return { type: 'simple', config: { vertical: v } }
    case 'tilt-down':   return { type: 'simple', config: { vertical: -v } }
    case 'orbit':       return { type: 'simple', config: { pan: v } }
    case 'static':      return { type: 'simple', config: {} }
  }
}

function clampN(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}
