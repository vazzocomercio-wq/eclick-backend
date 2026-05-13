/**
 * FlowProvider — placeholder pra Google Flow / Veo 3.1.
 *
 * NÃO IMPLEMENTADO AINDA. Quando ativarmos, vai usar Vertex AI:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning
 *
 * Models conhecidos (maio/2026):
 *   - veo-3.1-generate-preview        (Standard, $0.40/s, áudio nativo)
 *   - veo-3.1-fast-generate-preview   (Fast, $0.15/s, áudio nativo)
 *   - veo-3.1-lite-generate-preview   (Lite)
 *
 * Vantagens vs Kling:
 *   - Suporta `lastFrame` nativamente → encadeamento sem ffmpeg
 *   - Áudio nativo em TODOS os models
 *   - Resoluções: 720p, 1080p, 4K
 *
 * Durations: 4, 6, 8 segundos (mais granular que Kling)
 *
 * Integração futura: setar GOOGLE_VERTEX_API_KEY (ou OAuth via service account)
 * + GOOGLE_VERTEX_PROJECT_ID + GOOGLE_VERTEX_LOCATION (us-central1 default).
 *
 * Pra ativar:
 *   1. Implementar submit/poll/download usando Vertex AI REST
 *   2. Registrar este provider no module
 *   3. Pipeline já passa a aceitar provider='flow' automaticamente
 */

import { Injectable, NotImplementedException } from '@nestjs/common'
import type {
  VideoProvider,
  VideoModelOption,
  VideoSubmitInput,
  VideoTaskStatus,
} from './video-provider.interface'

@Injectable()
export class FlowProvider implements VideoProvider {
  readonly key = 'flow' as const

  /** Pricing aproximado por segundo (Veo 3.1, fonte: Vertex AI maio/2026) */
  private static readonly MODELS: VideoModelOption[] = [
    {
      id:                    'veo-3.1-generate-preview',
      label:                 'Veo 3.1 Standard',
      badge:                 'Google · 4K · áudio',
      provider:              'flow',
      quality:               'premium',
      hasAudio:              true,
      supportedDurations:    [4, 6, 8],
      supportsTailImage:     true,
      supportsCameraControl: false, // Veo infere motion do prompt
      pricing:               { 4: 1.60, 6: 2.40, 8: 3.20 },
    },
    {
      id:                    'veo-3.1-fast-generate-preview',
      label:                 'Veo 3.1 Fast',
      badge:                 'Google · rápido',
      provider:              'flow',
      quality:               'fast',
      hasAudio:              true,
      supportedDurations:    [4, 6, 8],
      supportsTailImage:     true,
      supportsCameraControl: false,
      pricing:               { 4: 0.60, 6: 0.90, 8: 1.20 },
    },
  ]

  listModels(): VideoModelOption[] {
    // Só lista se configurado — UI não mostra opção indisponível
    return this.isConfigured() ? FlowProvider.MODELS : []
  }

  submit(_input: VideoSubmitInput): Promise<{ taskId: string }> {
    throw new NotImplementedException(
      'FlowProvider ainda não implementado. Veo 3.1 (Google Vertex AI) entra em sprint futuro.',
    )
  }

  pollStatus(_taskId: string): Promise<VideoTaskStatus> {
    throw new NotImplementedException('FlowProvider.pollStatus not implemented')
  }

  download(_url: string): Promise<Buffer> {
    throw new NotImplementedException('FlowProvider.download not implemented')
  }

  estimateCost(modelId: string, duration: number): number {
    const model = FlowProvider.MODELS.find(m => m.id === modelId)
    return model?.pricing[duration] ?? 0
  }

  isConfigured(): boolean {
    // Stub: vai ser true quando as envs Vertex AI estiverem setadas
    return Boolean(
      process.env.GOOGLE_VERTEX_API_KEY
      && process.env.GOOGLE_VERTEX_PROJECT_ID,
    )
  }
}
