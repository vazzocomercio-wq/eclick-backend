import { Injectable, Logger } from '@nestjs/common'
import { LlmService } from '../../../ai/llm.service'
import { GeoDimensionResult, ScrapedListing } from '../../shared/types'

const MAX_CHARS = 5000

// Levers comprovados pela literatura GEO (ver [[geo-papers]]): estatísticas/dados,
// evidência (reviews/citações), fluência+escaneabilidade, alinhamento à intenção,
// USPs, FAQ — e factualidade. Keyword stuffing é COMPROVADAMENTE inútil/danoso.
const SYSTEM_PROMPT =
  'Você é especialista em GEO (Generative Engine Optimization) e copywriting de marketplace. ' +
  'Reescreve a descrição de um produto numa estrutura data-dense que IAs generativas (ChatGPT, ' +
  'Perplexity, Gemini) conseguem extrair, confiar e CITAR ao recomendar produtos. ' +
  'Princípios (baseados em evidência): (a) priorize DADOS e NÚMEROS concretos sobre adjetivos; ' +
  '(b) use evidência real (avaliações, certificações) como prova quando fornecida; ' +
  '(c) escreva fluente e escaneável (títulos curtos + bullets); ' +
  '(d) antecipe a INTENÇÃO de busca do comprador; ' +
  '(e) NUNCA repita a mesma palavra-chave pra "encher" (isso NÃO funciona em IA) — use vocabulário ' +
  'variado e sinônimos naturais; (f) mantenha 100% de FACTUALIDADE: não invente specs, números nem ' +
  'avaliações. Escreva em pt-BR, direto, sem floreio. Responda só o texto da descrição.'

@Injectable()
export class DescriptionBuilderService {
  private readonly logger = new Logger(DescriptionBuilderService.name)

  constructor(private readonly llm: LlmService) {}

  /** Gera a nova descrição estruturada (com FAQ inline gerada a partir de fatos). */
  async build(
    orgId: string,
    listing: ScrapedListing,
    breakdown: GeoDimensionResult[] | null,
  ): Promise<{ description: string; costUsd: number }> {
    const attrs = listing.attributes.slice(0, 30).map(a => `${a.name}: ${a.value}`).join('\n') || '(sem atributos)'
    const weak = (breakdown ?? []).filter(d => d.score < 7).map(d => d.name).join(', ') || '(sem auditoria prévia)'
    // Evidência real disponível (só citar se existir — não inventar).
    const evidence = (listing.reviews_count && listing.reviews_count > 0)
      ? `Avaliações reais: ${listing.reviews_count} avaliações${listing.rating ? `, nota média ${listing.rating}/5` : ''}.`
      : '(sem avaliações registradas — NÃO mencione avaliações)'

    const userPrompt =
      `Produto: ${listing.title ?? '(sem título)'}\n` +
      `Categoria: ${listing.category ?? '(n/d)'}\n` +
      `Preço: ${listing.price ?? '(n/d)'}\n` +
      `Atributos:\n${attrs}\n` +
      `Evidência: ${evidence}\n` +
      `Descrição atual:\n${(listing.description ?? '(vazia)').slice(0, 2500)}\n` +
      `Dimensões fracas do GEO Score (priorize melhorá-las): ${weak}\n\n` +
      `Reescreva a descrição (NO MÁXIMO ${MAX_CHARS} caracteres) NESTA estrutura, nesta ordem:\n` +
      `1. RESUMO em 2 linhas (o que é + principal benefício, com a INTENÇÃO de uso — pra IA extrair logo de cara).\n` +
      `2. ESPECIFICAÇÕES em lista (cada item: **Atributo:** valor). Inclua NÚMEROS e medidas concretas sempre que constarem nos dados (dados quantitativos aumentam a citação por IA).\n` +
      `3. PARA QUEM SERVE: 3 a 5 perfis/casos de uso claros (alinhados às buscas reais do comprador).\n` +
      `4. PARA QUEM NÃO SERVE: 1 a 2 perfis (o contraste aumenta a citação por IA).\n` +
      `5. DIFERENCIAIS vs alternativas da categoria: o que torna este produto superior, factual, SEM citar concorrente por nome.\n` +
      `6. EVIDÊNCIA: se (e somente se) houver avaliações/certificações nos dados acima, cite-as como prova de confiança. Caso contrário, OMITA esta seção (não invente).\n` +
      `7. PERGUNTAS FREQUENTES: 3 a 4 perguntas REAIS que um comprador faria (dúvidas de compra/uso/compatibilidade), respondidas APENAS com base nos fatos fornecidos. Se um dado não constar, responda orientando honestamente (ex.: "confirme no manual/conosco antes da compra") — nunca invente.\n` +
      `8. CTA final curto.\n\n` +
      `REGRAS: 100% factual (não invente specs, números nem avaliações). Vocabulário VARIADO — não repita a mesma palavra-chave pra encher (keyword stuffing não funciona em IA). Texto fluente e escaneável.`

    try {
      const out = await this.llm.generateText({
        orgId, feature: 'ai_visibility_description',
        systemPrompt: SYSTEM_PROMPT, userPrompt, maxTokens: 2800, temperature: 0.4,
      })
      return { description: (out.text ?? '').trim().slice(0, MAX_CHARS), costUsd: out.costUsd }
    } catch (e) {
      this.logger.warn(`[description-builder] falhou: ${(e as Error).message}`)
      return { description: '', costUsd: 0 }
    }
  }
}
