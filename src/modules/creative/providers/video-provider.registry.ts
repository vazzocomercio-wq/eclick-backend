/**
 * VideoProviderRegistry — escolhe o provider apropriado pra um modelo.
 *
 * Uso típico:
 *   const provider = this.registry.resolve('kling-v2-6')
 *   await provider.submit({ ... })
 *
 * Resolução:
 *   - Se modelId começa com 'kling-' → KlingProvider
 *   - Se modelId começa com 'veo-' → FlowProvider
 *   - Default (sem hint) → Kling (provider primário hoje)
 */

import { Injectable, BadRequestException } from '@nestjs/common'
import type { VideoModelOption, VideoProvider } from './video-provider.interface'
import { KlingProvider } from './kling.provider'
import { FlowProvider } from './flow.provider'

@Injectable()
export class VideoProviderRegistry {
  constructor(
    private readonly kling: KlingProvider,
    private readonly flow:  FlowProvider,
  ) {}

  /** Lista TODOS os modelos disponíveis (de todos os providers configurados). */
  listAllModels(): VideoModelOption[] {
    return [
      ...this.kling.listModels(),
      ...this.flow.listModels(),
    ]
  }

  /** Resolve qual provider responde por um modelId. Lança se desconhecido. */
  resolve(modelId: string): VideoProvider {
    if (modelId.startsWith('kling-')) {
      if (!this.kling.isConfigured()) {
        throw new BadRequestException('Kling não configurado. Setar KLING_ACCESS_KEY/KLING_SECRET_KEY no Railway.')
      }
      return this.kling
    }
    if (modelId.startsWith('veo-')) {
      if (!this.flow.isConfigured()) {
        throw new BadRequestException('Google Flow/Veo não configurado. Setar GOOGLE_VERTEX_* envs no Railway.')
      }
      return this.flow
    }
    throw new BadRequestException(`modelId desconhecido: ${modelId}. Use kling-* ou veo-*.`)
  }

  /** Resolve provider pelo key direto. */
  resolveByKey(key: 'kling' | 'flow'): VideoProvider {
    return key === 'kling' ? this.kling : this.flow
  }
}
