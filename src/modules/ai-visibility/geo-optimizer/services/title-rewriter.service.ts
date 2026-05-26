import { Injectable, Logger } from '@nestjs/common'
import { LlmService } from '../../../ai/llm.service'
import { GeoDimensionResult, ScrapedListing, TitleVariation, TitleVariant } from '../../shared/types'

/** Limite de caracteres do título por plataforma. */
function maxTitleChars(platform: string): number {
  return platform === 'mercadolivre' ? 60 : 100 // ML 60; Shopee/Amazon/site 100
}

// Levers comprovados (ver [[geo-papers]]): alinhamento à intenção de busca, 1 diferencial
// concreto/quantitativo, linguagem natural. Keyword stuffing NÃO funciona em IA.
const SYSTEM_PROMPT =
  'Você é especialista em GEO (Generative Engine Optimization) e copy de marketplace. ' +
  'Reescreve títulos pra serem encontrados e citados por IAs generativas (ChatGPT, Perplexity, Gemini). ' +
  'Cada título deve: começar pelo termo mais relevante à busca do comprador, incluir 1 diferencial ' +
  'concreto (spec/medida/material) quando couber, soar natural (como a pessoa pede pra uma IA), e ' +
  'NUNCA empilhar palavras-chave repetidas (keyword stuffing não funciona em IA). Mantenha factual. ' +
  'Gera 3 variações com ângulos distintos. Responda somente JSON.'

@Injectable()
export class TitleRewriterService {
  private readonly logger = new Logger(TitleRewriterService.name)

  constructor(private readonly llm: LlmService) {}

  async generate(
    orgId: string,
    listing: ScrapedListing,
    breakdown: GeoDimensionResult[] | null,
  ): Promise<{ variations: TitleVariation[]; costUsd: number }> {
    const limit = maxTitleChars(listing.platform)
    const weak = (breakdown ?? []).filter(d => d.score < 7).map(d => d.name).join(', ') || '(sem auditoria prévia)'
    const attrs = listing.attributes.slice(0, 20).map(a => `${a.name}: ${a.value}`).join('; ')

    const userPrompt =
      `Produto (plataforma ${listing.platform}, limite ${limit} chars por título):\n` +
      `Título atual: ${listing.title ?? '(sem título)'}\n` +
      `Categoria: ${listing.category ?? '(n/d)'}\n` +
      `Atributos: ${attrs || '(nenhum)'}\n` +
      `Dimensões fracas do GEO Score: ${weak}\n\n` +
      `Gere 3 variações de título (cada uma com NO MÁXIMO ${limit} caracteres):\n` +
      `- A (transacional): foco em conversão direta, keyword principal + atributos-chave.\n` +
      `- B (comparativa): otimizada pra buscas "melhor X para Y" / casos de uso.\n` +
      `- C (informacional): query longa natural, como alguém perguntaria pra uma IA.\n\n` +
      `Responda JSON: {"variations":[{"variant":"A","type":"transacional","title":"...","reasoning":"1-2 frases","target_query":"a query natural que esse título atende","estimated_geo_lift":0-10}]}`

    try {
      const out = await this.llm.generateText({
        orgId, feature: 'ai_visibility_title_rewrite',
        systemPrompt: SYSTEM_PROMPT, userPrompt, jsonMode: true, maxTokens: 900, temperature: 0.5,
      })
      const variations = this.parse(out.text, limit)
      return { variations, costUsd: out.costUsd }
    } catch (e) {
      this.logger.warn(`[title-rewriter] falhou: ${(e as Error).message}`)
      return { variations: [], costUsd: 0 }
    }
  }

  private parse(text: string, limit: number): TitleVariation[] {
    let arr: Array<Record<string, unknown>> = []
    try {
      const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
      const obj = JSON.parse(cleaned) as { variations?: unknown }
      if (Array.isArray(obj.variations)) arr = obj.variations as Array<Record<string, unknown>>
    } catch { /* retorna o que conseguir */ }

    const variants: TitleVariant[] = ['A', 'B', 'C']
    const types = { A: 'transacional', B: 'comparativa', C: 'informacional' } as const
    return arr.slice(0, 3).map((r, i) => {
      const variant = (['A', 'B', 'C'].includes(String(r.variant)) ? r.variant : variants[i]) as TitleVariant
      const n = Number(r.estimated_geo_lift)
      return {
        variant,
        type: types[variant],
        title: String(r.title ?? '').trim().slice(0, limit),  // garante o limite
        reasoning: String(r.reasoning ?? '').slice(0, 300),
        target_query: String(r.target_query ?? '').slice(0, 200),
        estimated_geo_lift: Math.max(0, Math.min(10, Number.isFinite(n) ? n : 0)),
      }
    }).filter(v => v.title)
  }
}
