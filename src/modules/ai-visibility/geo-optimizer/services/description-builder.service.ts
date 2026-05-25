import { Injectable, Logger } from '@nestjs/common'
import { LlmService } from '../../../ai/llm.service'
import { GeoDimensionResult, ScrapedListing } from '../../shared/types'

const MAX_CHARS = 5000

const SYSTEM_PROMPT =
  'Você é especialista em GEO (Generative Engine Optimization) e copywriting de marketplace. ' +
  'Reescreve a descrição de um produto numa estrutura data-dense que IAs generativas conseguem ' +
  'extrair e citar. Escreva em pt-BR, direto, sem floreio. Responda só o texto da descrição.'

@Injectable()
export class DescriptionBuilderService {
  private readonly logger = new Logger(DescriptionBuilderService.name)

  constructor(private readonly llm: LlmService) {}

  /** Gera a nova descrição estruturada. FAQ embutida fica pro Dia 11. */
  async build(
    orgId: string,
    listing: ScrapedListing,
    breakdown: GeoDimensionResult[] | null,
  ): Promise<{ description: string; costUsd: number }> {
    const attrs = listing.attributes.slice(0, 30).map(a => `${a.name}: ${a.value}`).join('\n') || '(sem atributos)'
    const weak = (breakdown ?? []).filter(d => d.score < 7).map(d => d.name).join(', ') || '(sem auditoria prévia)'

    const userPrompt =
      `Produto: ${listing.title ?? '(sem título)'}\n` +
      `Categoria: ${listing.category ?? '(n/d)'}\n` +
      `Atributos:\n${attrs}\n` +
      `Descrição atual:\n${(listing.description ?? '(vazia)').slice(0, 2500)}\n` +
      `Dimensões fracas do GEO Score: ${weak}\n\n` +
      `Reescreva a descrição (NO MÁXIMO ${MAX_CHARS} caracteres) NESTA estrutura, nesta ordem:\n` +
      `1. RESUMO em 2 linhas (o que é + principal benefício — pra IA extrair logo de cara).\n` +
      `2. ESPECIFICAÇÕES em lista (cada item: **Atributo:** valor).\n` +
      `3. PARA QUEM SERVE: 3 a 5 perfis claros de uso/cliente.\n` +
      `4. PARA QUEM NÃO SERVE: 1 a 2 perfis (o contraste aumenta a citação por IA).\n` +
      `5. COMPARATIVO IMPLÍCITO: como se posiciona vs alternativas da categoria (sem citar concorrente por nome).\n` +
      `6. CTA final curto.\n` +
      `Não invente specs que não estão nos atributos. Deixe um marcador "[FAQ]" onde a FAQ entraria (será preenchida depois).`

    try {
      const out = await this.llm.generateText({
        orgId, feature: 'ai_visibility_description',
        systemPrompt: SYSTEM_PROMPT, userPrompt, maxTokens: 2200, temperature: 0.4,
      })
      return { description: (out.text ?? '').trim().slice(0, MAX_CHARS), costUsd: out.costUsd }
    } catch (e) {
      this.logger.warn(`[description-builder] falhou: ${(e as Error).message}`)
      return { description: '', costUsd: 0 }
    }
  }
}
