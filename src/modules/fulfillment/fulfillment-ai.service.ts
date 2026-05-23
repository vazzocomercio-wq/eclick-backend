import { Injectable, Logger } from '@nestjs/common'
import { LlmService } from '../ai/llm.service'
import type { DamageSeverity, DamageResolution } from './fulfillment.types'

/**
 * IA OPCIONAL do fulfillment (toggles em fulfillment_settings, OFF por padrão).
 * Todas as chamadas são BEST-EFFORT: nunca lançam — se a IA falhar, o fluxo
 * operacional continua normalmente (a IA é assistiva, não bloqueante).
 *
 * Usa LlmService.analyzeImage (visão via Anthropic). As features
 * `fulfillment_damage_triage` / `fulfillment_pack_verify` precisam ter
 * provider primário anthropic (ver ai/defaults.ts).
 */
@Injectable()
export class FulfillmentAiService {
  private readonly logger = new Logger(FulfillmentAiService.name)

  constructor(private readonly llm: LlmService) {}

  /** Triagem de avaria por foto: severidade + destino sugeridos. */
  async triageDamage(input: {
    orgId: string
    sku: string
    imageUrl: string
    description?: string
  }): Promise<{
    severity?: DamageSeverity
    resolution?: DamageResolution
    confidence?: number
    analysis?: Record<string, unknown>
  } | null> {
    try {
      const out = await this.llm.analyzeImage({
        orgId:   input.orgId,
        feature: 'fulfillment_damage_triage',
        imageUrl: input.imageUrl,
        jsonMode: true,
        maxTokens: 600,
        systemPrompt:
          'Você é um conferente de avarias de um centro de distribuição. Analise a foto do produto avariado '
          + 'e classifique. Responda SOMENTE com JSON no formato exato: '
          + '{"severity":"minor|major|total_loss","resolution":"discard|return_supplier|sell_as_b|pending",'
          + '"confidence":0.0-1.0,"reason":"texto curto em pt-BR"}. '
          + 'minor=arranhão/embalagem; major=funcional comprometido; total_loss=imprestável. '
          + 'sell_as_b=vendável como produto B (defeito estético leve).',
        userPrompt: `SKU: ${input.sku}. ${input.description ? 'Relato do operador: ' + input.description : ''}`.trim(),
      })
      const parsed = safeJson(out.text)
      if (!parsed) return null
      return {
        severity:   pickEnum(parsed.severity, ['minor', 'major', 'total_loss']) as DamageSeverity | undefined,
        resolution: pickEnum(parsed.resolution, ['discard', 'return_supplier', 'sell_as_b', 'pending']) as DamageResolution | undefined,
        confidence: typeof parsed.confidence === 'number' ? clamp01(parsed.confidence) : undefined,
        analysis:   parsed as Record<string, unknown>,
      }
    } catch (e) {
      this.logger.warn(`[ai] triageDamage falhou (best-effort): ${(e as Error).message}`)
      return null
    }
  }

  /** Conferência do pacote por foto: confere se os itens esperados aparecem. */
  async verifyPackPhoto(input: {
    orgId: string
    imageUrl: string
    expectedItems: Array<{ sku: string; title?: string; qty: number }>
  }): Promise<{ passed?: boolean; result?: Record<string, unknown> } | null> {
    try {
      const itemsTxt = input.expectedItems
        .map((i) => `- ${i.qty}x ${i.sku}${i.title ? ' (' + i.title + ')' : ''}`)
        .join('\n')
      const out = await this.llm.analyzeImage({
        orgId:   input.orgId,
        feature: 'fulfillment_pack_verify',
        imageUrl: input.imageUrl,
        jsonMode: true,
        maxTokens: 700,
        systemPrompt:
          'Você confere pacotes antes da expedição. Olhe a foto do pacote/itens e diga se os itens esperados '
          + 'parecem estar presentes e corretos. Responda SOMENTE com JSON: '
          + '{"passed":true|false,"confidence":0.0-1.0,"notes":"texto curto pt-BR","concerns":["..."]}. '
          + 'Seja conservador: na dúvida, passed=false com a observação do porquê.',
        userPrompt: `Itens esperados:\n${itemsTxt}`,
      })
      const parsed = safeJson(out.text)
      if (!parsed) return null
      return {
        passed: typeof parsed.passed === 'boolean' ? parsed.passed : undefined,
        result: parsed as Record<string, unknown>,
      }
    } catch (e) {
      this.logger.warn(`[ai] verifyPackPhoto falhou (best-effort): ${(e as Error).message}`)
      return null
    }
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  if (!text) return null
  try {
    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const parsed = JSON.parse(cleaned)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function pickEnum(v: unknown, allowed: string[]): string | undefined {
  return typeof v === 'string' && allowed.includes(v) ? v : undefined
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}
