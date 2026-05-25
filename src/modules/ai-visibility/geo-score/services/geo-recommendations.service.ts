import { Injectable, Logger } from '@nestjs/common'
import { LlmService } from '../../../ai/llm.service'
import { GeoDimensionResult, GeoRecommendation, ScrapedListing } from '../../shared/types'

const WEIGHT_SUM = 9.0   // Σ pesos (igual ao calculator)
const SCORE_THRESHOLD = 7 // dimensões abaixo disso viram candidatas a fix
const MAX_FIXES = 5

const SYSTEM_PROMPT =
  'Você é consultor de GEO (Generative Engine Optimization). Recebe as dimensões fracas ' +
  'de um listing e escreve correções práticas e específicas (não genéricas), com exemplo ' +
  'de antes e depois reescrito. Responda somente JSON.'

@Injectable()
export class GeoRecommendationsService {
  private readonly logger = new Logger(GeoRecommendationsService.name)

  constructor(private readonly llm: LlmService) {}

  /** Gera os top fixes (≤5) pras dimensões com nota < 7, ordenados por peso×gap. */
  async generate(
    orgId: string,
    listing: ScrapedListing,
    dimensions: GeoDimensionResult[],
  ): Promise<{ recommendations: GeoRecommendation[]; costUsd: number }> {
    const weak = dimensions
      .filter(d => d.score < SCORE_THRESHOLD)
      .map(d => ({ ...d, gap: 10 - d.score, impact: this.impactPoints(d.weight, 10 - d.score) }))
      .sort((a, b) => b.weight * b.gap - a.weight * a.gap)
      .slice(0, MAX_FIXES)

    if (weak.length === 0) return { recommendations: [], costUsd: 0 }

    const userPrompt =
      `Listing:\n${this.buildContext(listing)}\n\n` +
      `Dimensões fracas (gere 1 correção pra CADA, na mesma ordem):\n` +
      weak.map((d, i) =>
        `${i + 1}. ${d.name} (nota ${d.score}/10) — diagnóstico: ${d.reasoning} | evidência: ${d.evidence || '(sem trecho)'}`,
      ).join('\n') +
      `\n\nResponda JSON: {"recommendations":[{"dimension":"<nome exato>","title":"curto","description":"2-3 frases","example_before":"trecho atual ou ''","example_after":"versão otimizada"}]}`

    let costUsd = 0
    let parsed: Array<Record<string, unknown>> = []
    try {
      const out = await this.llm.generateText({
        orgId,
        feature:    'ai_visibility_geo_recommendations',
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        jsonMode:   true,
        maxTokens:  1500,
        temperature: 0.3,
      })
      costUsd = out.costUsd
      parsed = this.parseRecs(out.text)
    } catch (e) {
      this.logger.warn(`[geo-rec] geração falhou: ${(e as Error).message}`)
    }

    // Casa cada rec gerada com a dimensão fraca (pela ordem/nome) e anexa
    // severity + estimated_impact calculados (números confiáveis, não do LLM).
    const recommendations: GeoRecommendation[] = weak.map((d, i) => {
      const r = parsed.find(p => String(p.dimension) === d.name) ?? parsed[i] ?? {}
      return {
        dimension:        d.name,
        severity:         this.severity(d.impact),
        title:            String(r.title ?? `Melhorar ${d.name}`).slice(0, 120),
        description:      String(r.description ?? d.reasoning).slice(0, 500),
        example_before:   String(r.example_before ?? '').slice(0, 600),
        example_after:    String(r.example_after ?? '').slice(0, 600),
        estimated_impact: `+${d.impact} pontos se aplicar`,
      }
    })

    return { recommendations, costUsd }
  }

  /** Pontos no score 0-100 que a dimensão ganharia indo de score atual → 10. */
  private impactPoints(weight: number, gap: number): number {
    return Math.round((weight * gap) / (10 * WEIGHT_SUM) * 100)
  }

  private severity(impact: number): 'high' | 'medium' | 'low' {
    if (impact >= 8) return 'high'
    if (impact >= 4) return 'medium'
    return 'low'
  }

  private parseRecs(text: string): Array<Record<string, unknown>> {
    try {
      const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
      const obj = JSON.parse(cleaned) as { recommendations?: unknown }
      return Array.isArray(obj.recommendations) ? obj.recommendations as Array<Record<string, unknown>> : []
    } catch {
      return []
    }
  }

  private buildContext(l: ScrapedListing): string {
    const desc = (l.description ?? '(sem descrição)').slice(0, 1500)
    return [
      `Plataforma: ${l.platform} | Título: ${l.title ?? '(sem título)'}`,
      `Categoria: ${l.category ?? '(n/d)'} | Atributos: ${l.attributes.length} | Reviews: ${l.reviews_count ?? 0}`,
      `Descrição: ${desc}`,
    ].join('\n')
  }
}
