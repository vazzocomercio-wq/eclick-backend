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
import { SoraProvider } from './sora.provider'

@Injectable()
export class VideoProviderRegistry {
  constructor(
    private readonly kling: KlingProvider,
    private readonly flow:  FlowProvider,
    private readonly sora:  SoraProvider,
  ) {}

  /** Lista TODOS os modelos disponíveis (de todos os providers configurados). */
  listAllModels(): VideoModelOption[] {
    return [
      ...this.kling.listModels(),
      ...this.flow.listModels(),
      ...this.sora.listModels(),
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
      // FlowProvider.isConfigured() é sempre true (resolução real é async via DB).
      // Se a key não existir, submit() lança BadRequestException com mensagem clara.
      return this.flow
    }
    if (modelId.startsWith('sora-')) {
      // SoraProvider.isConfigured() é sempre true (resolução real é async via DB).
      // Se a OPENAI_API_KEY não existir, submit() lança BadRequestException.
      return this.sora
    }
    throw new BadRequestException(`modelId desconhecido: ${modelId}. Use kling-*, veo-* ou sora-*.`)
  }

  /** Resolve provider pelo key direto. */
  resolveByKey(key: 'kling' | 'flow' | 'sora'): VideoProvider {
    if (key === 'kling') return this.kling
    if (key === 'flow')  return this.flow
    return this.sora
  }
}
