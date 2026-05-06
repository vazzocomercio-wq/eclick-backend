import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { LlmService } from '../ai/llm.service'
import { supabaseAdmin } from '../../common/supabase'
import { matchKbEntries, KB, type KbEntry } from './copilot.kb'

interface ChatInput {
  orgId:        string
  pathname:     string                    // ex: /dashboard/produtos/abc/ai
  question:     string
  history?:     Array<{ role: 'user' | 'assistant'; content: string }>
}

@Injectable()
export class CopilotService {
  private readonly logger = new Logger(CopilotService.name)

  constructor(private readonly llm: LlmService) {}

  /** Retorna entries da KB que matcham a route atual. UI usa pra mostrar
   *  topics relacionados antes do user perguntar. */
  getRouteContext(pathname: string): { entries: KbEntry[]; total_kb_size: number } {
    const entries = matchKbEntries(pathname)
    return { entries, total_kb_size: KB.length }
  }

  /** Chat principal — recebe pergunta + pathname, monta prompt com KB
   *  excerpt relevante, chama Haiku (rápido). */
  async chat(input: ChatInput): Promise<{
    answer:     string
    matched_kb: number
    cost_usd:   number
  }> {
    if (!input.question?.trim()) {
      throw new BadRequestException('question obrigatório')
    }

    const matched = matchKbEntries(input.pathname)

    // Limita KB excerpt a ~3000 chars pra economizar tokens
    let kbExcerpt = ''
    for (const entry of matched) {
      const block = `### ${entry.title}\n${entry.content}\n\n`
      if (kbExcerpt.length + block.length > 3000) break
      kbExcerpt += block
    }

    if (!kbExcerpt) {
      kbExcerpt = '(Sem documentação específica pra esta tela. Ajude com base no nome da rota.)'
    }

    const systemPrompt = `Você é um copiloto/professor embutido no e-Click SaaS.

Sua função: ajudar o usuário a entender a tela atual, features, melhores práticas e como extrair valor.

REGRAS:
- Responda em português brasileiro, tom amigável mas direto.
- Use markdown (negrito, listas, código inline) — frontend renderiza.
- Seja conciso: 2-4 parágrafos curtos OU lista. Nunca resposta longa demais.
- Foque em AÇÃO ("pra fazer X, clique Y") em vez de teoria.
- Se a pergunta for fora do seu conhecimento, diga: "ainda não tenho info sobre isso. Posso te ajudar com X que está nesta tela?".
- Se a pergunta for sobre erro/bug, sugira o caminho operacional (ex: "verifica se KLING_API_KEY está no Railway").
- NUNCA invente features que não estão na sua KB.`

    const userPrompt = `## TELA ATUAL
${input.pathname}

## CONHECIMENTO RELEVANTE
${kbExcerpt}

## PERGUNTA DO USUÁRIO
${input.question.trim()}

${input.history && input.history.length > 0 ? `## HISTÓRICO DA CONVERSA\n${input.history.slice(-3).map(h => `${h.role}: ${h.content}`).join('\n')}\n` : ''}
Responda agora:`

    const out = await this.llm.generateText({
      orgId:        input.orgId,
      feature:      'copilot_help',
      systemPrompt,
      userPrompt,
      maxTokens:    600,
      temperature:  0.3, // baixa pra ser factual
    })

    return {
      answer:     out.text,
      matched_kb: matched.length,
      cost_usd:   out.costUsd,
    }
  }

  /** Lista de KB entries por categoria — pra UI de explorar tópicos. */
  listKbByCategory(): Record<string, Array<{ title: string; tags: string[]; routes: string[] }>> {
    const grouped: Record<string, Array<{ title: string; tags: string[]; routes: string[] }>> = {}
    for (const entry of KB) {
      const cat = entry.category ?? 'outros'
      if (!grouped[cat]) grouped[cat] = []
      grouped[cat].push({ title: entry.title, tags: entry.tags ?? [], routes: entry.routes })
    }
    return grouped
  }

  /** Feedback do user sobre uma resposta — registra em ai_usage_log via
   *  metadata pro futuro tuning de KB / prompt. */
  async recordFeedback(input: {
    orgId:        string
    userId:       string
    pathname:     string
    question:     string
    answer:       string
    rating:       'up' | 'down'
    comment?:     string
  }): Promise<{ ok: true }> {
    if (!input.question?.trim() || !input.answer?.trim()) {
      throw new BadRequestException('question + answer obrigatórios')
    }
    if (input.rating !== 'up' && input.rating !== 'down') {
      throw new BadRequestException('rating deve ser up|down')
    }

    // Loga em ai_usage_log com error_message=feedback (gambiarra simples)
    // ou em tabela dedicada futura. Pra MVP usa o que já tem.
    try {
      await supabaseAdmin.from('ai_usage_log').insert({
        organization_id: input.orgId,
        provider:        'feedback',
        model:           'copilot_help',
        feature:         'copilot_help',
        tokens_input:    0,
        tokens_output:   0,
        tokens_total:    0,
        cost_usd:        0,
        latency_ms:      0,
        fallback_used:   false,
        error_message:   JSON.stringify({
          type: 'copilot_feedback',
          rating: input.rating,
          pathname: input.pathname,
          question: input.question.slice(0, 500),
          answer: input.answer.slice(0, 1000),
          comment: input.comment?.slice(0, 500) ?? null,
          user_id: input.userId,
        }),
      })
    } catch (e) {
      this.logger.warn(`[copilot.feedback] insert falhou: ${(e as Error).message}`)
    }

    return { ok: true }
  }
}
