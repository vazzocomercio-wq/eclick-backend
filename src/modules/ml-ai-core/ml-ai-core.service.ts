import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { LlmService } from '../ai/llm.service'
import {
  CLASSIFIER_INTENTS,
  CLASSIFIER_RISKS,
  CLASSIFIER_SENTIMENTS,
  CLASSIFIER_URGENCIES,
  CLASSIFIER_SYSTEM_PROMPT,
  buildClassifierUserPrompt,
  type ClassifierContext,
  type ClassifierIntent,
  type ClassifierRisk,
  type ClassifierSentiment,
  type ClassifierUrgency,
} from './prompts/classifier.prompt'
import {
  POSTSALE_MAX_CHARS,
  buildSuggestPostsaleSystemPrompt,
  buildSuggestPostsaleUserPrompt,
  type SuggestPostsaleContext,
} from './prompts/suggest-postsale.prompt'
import {
  buildSuggestQuestionSystemPrompt,
  buildSuggestQuestionUserPrompt,
  stripQuestionMarkdownHeader,
  type SuggestQuestionContext,
} from './prompts/suggest-question.prompt'
import {
  TONE_VARIANTS,
  buildTransformToneSystemPrompt,
  buildTransformToneUserPrompt,
  type ToneVariant,
} from './prompts/transform-tone.prompt'

/**
 * Núcleo compartilhado de IA pros módulos de Mercado Livre (perguntas pré-venda
 * e mensagens pós-venda). Centraliza prompts, classificação, geração e tom.
 *
 * Toda chamada passa pelo LlmService → resolução de provider/modelo per-org +
 * fallback automático + log em ai_usage_log. Custo é exposto pra quem chama
 * gravar em tabelas específicas (ex: ml_ai_suggestions.llm_cost_usd).
 */
@Injectable()
export class MlAiCoreService {
  private readonly logger = new Logger(MlAiCoreService.name)

  constructor(private readonly llm: LlmService) {}

  // ── Classificação (Haiku, JSON estruturado) ──────────────────────────────

  /**
   * Classifica uma mensagem pós-venda. Saída validada com type guards
   * (sem zod pra não adicionar dep). Falha se LLM retornar shape inválido —
   * o caller decide se loga skipped ou retry.
   */
  async classify(orgId: string, text: string, context?: ClassifierContext): Promise<ClassificationResult> {
    if (!text?.trim()) throw new BadRequestException('text obrigatório')

    const out = await this.llm.generateText({
      orgId,
      feature:      'ml_postsale_classify',
      systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
      userPrompt:   buildClassifierUserPrompt(text.trim(), context),
      maxTokens:    400,
      jsonMode:     true,
    })

    const parsed = parseClassifierJson(out.text)
    return {
      ...parsed,
      llm: pickLlmMeta(out),
    }
  }

  // ── Sugestão pós-venda (Sonnet, ≤350 chars com regenerate-once) ─────────

  /**
   * Gera resposta pós-venda. Se o modelo estourar 350 chars na primeira
   * tentativa, regenera 1x com instrução reforçada. Persistência fica por
   * conta do caller.
   */
  async suggestPostsale(orgId: string, ctx: SuggestPostsaleContext): Promise<SuggestionResult> {
    if (!ctx.lastBuyerMessage?.trim()) {
      throw new BadRequestException('lastBuyerMessage obrigatório')
    }

    const userPrompt = buildSuggestPostsaleUserPrompt(ctx)

    // Tentativa 1
    const first = await this.llm.generateText({
      orgId,
      feature:      'ml_postsale_suggest',
      systemPrompt: buildSuggestPostsaleSystemPrompt(ctx.persona, false),
      userPrompt,
      maxTokens:    400,
      temperature:  0.3,
    })
    const firstText = sanitizePostsale(first.text)
    if (firstText.length <= POSTSALE_MAX_CHARS) {
      return {
        text:      firstText,
        charCount: firstText.length,
        regenerated: false,
        llm:       pickLlmMeta(first),
      }
    }

    this.logger.warn(`[ml-ai-core] suggestPostsale primeira tentativa estourou (${firstText.length} chars) — regenerando`)

    // Tentativa 2: instrução reforçada
    const second = await this.llm.generateText({
      orgId,
      feature:      'ml_postsale_suggest',
      systemPrompt: buildSuggestPostsaleSystemPrompt(ctx.persona, true),
      userPrompt:   `${userPrompt}\n\nA tentativa anterior estourou ${POSTSALE_MAX_CHARS} caracteres. Encurte AGORA. Conte cada caractere.`,
      maxTokens:    400,
      temperature:  0.2,
    })
    const secondText = sanitizePostsale(second.text)
    // Mesmo se estourar, devolvemos o melhor — service de cima decide se trunca/skipa
    const final = secondText.length <= POSTSALE_MAX_CHARS
      ? secondText
      : secondText.slice(0, POSTSALE_MAX_CHARS).trim()
    return {
      text:      final,
      charCount: final.length,
      regenerated: true,
      llm:       pickLlmMeta(second),
    }
  }

  // ── Sugestão pergunta pré-venda (migrada do ml-questions-ai.service) ────

  /**
   * Gera resposta pra pergunta pré-venda. Comportamento idêntico ao código
   * legado em ml-questions-ai.service.ts (3 linhas, sem markdown). Aplica
   * stripMarkdownHeader sobre o output.
   */
  async suggestQuestion(orgId: string, ctx: SuggestQuestionContext): Promise<QuestionSuggestionResult> {
    if (!ctx.questionText?.trim()) throw new BadRequestException('questionText obrigatório')

    const out = await this.llm.generateText({
      orgId,
      feature:      'ml_question_suggest',
      systemPrompt: buildSuggestQuestionSystemPrompt(ctx.agentSystemPrompt),
      userPrompt:   buildSuggestQuestionUserPrompt(ctx),
      maxTokens:    300,
    })

    const cleaned = stripQuestionMarkdownHeader(out.text)
    return {
      text: cleaned,
      llm:  pickLlmMeta(out),
    }
  }

  // ── Transformação de tom (Haiku) ────────────────────────────────────────

  /**
   * Reescreve texto com tom mais empático ou objetivo, mantendo ≤350 chars.
   * Trunca defensivamente se modelo estourar.
   */
  async transformTone(orgId: string, text: string, tone: ToneVariant): Promise<SuggestionResult> {
    if (!text?.trim()) throw new BadRequestException('text obrigatório')
    if (!TONE_VARIANTS.includes(tone)) {
      throw new BadRequestException(`tone inválido: ${tone}`)
    }

    const out = await this.llm.generateText({
      orgId,
      feature:      'ml_postsale_transform',
      systemPrompt: buildTransformToneSystemPrompt(tone),
      userPrompt:   buildTransformToneUserPrompt(text),
      maxTokens:    400,
    })

    const sanitized = sanitizePostsale(out.text)
    const final = sanitized.length <= POSTSALE_MAX_CHARS
      ? sanitized
      : sanitized.slice(0, POSTSALE_MAX_CHARS).trim()
    return {
      text:      final,
      charCount: final.length,
      regenerated: false,
      llm:       pickLlmMeta(out),
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// Tipos e helpers internos
// ════════════════════════════════════════════════════════════════════════

export interface LlmMeta {
  provider:     string
  model:        string
  inputTokens:  number
  outputTokens: number
  costUsd:      number
  latencyMs:    number
  fallbackUsed: boolean
}

export interface ClassificationResult {
  intent:        ClassifierIntent
  sentiment:     ClassifierSentiment
  urgency:       ClassifierUrgency
  risk:          ClassifierRisk
  canAutoReply:  boolean
  llm:           LlmMeta
}

export interface SuggestionResult {
  text:        string
  charCount:   number
  regenerated: boolean
  llm:         LlmMeta
}

export interface QuestionSuggestionResult {
  text: string
  llm:  LlmMeta
}

function pickLlmMeta(out: { provider: string; model: string; inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number; fallbackUsed: boolean }): LlmMeta {
  return {
    provider:     out.provider,
    model:        out.model,
    inputTokens:  out.inputTokens,
    outputTokens: out.outputTokens,
    costUsd:      out.costUsd,
    latencyMs:    out.latencyMs,
    fallbackUsed: out.fallbackUsed,
  }
}

/** Remove emoji, markdown, headers, aspas envolventes — mantém só texto cru. */
function sanitizePostsale(raw: string): string {
  let text = raw.trim()
  // Remove markdown headers no início
  while (/^\s*#{1,6}\s+/.test(text)) {
    text = text.replace(/^\s*#{1,6}\s+[^\n]*\n*/, '').trim()
  }
  // "Resposta:" / "Resposta ao Cliente:" etc.
  text = text.replace(/^(?:#+\s*)?Resposta(\s+ao\s+Cliente)?\s*:?\s*/i, '').trim()
  // **negrito** → texto puro
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  // _itálico_ → texto puro
  text = text.replace(/_([^_]+)_/g, '$1')
  // Remove aspas envolvendo a resposta inteira (modelo às vezes faz isso)
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim()
  }
  // Compress whitespace múltiplo em 1 espaço (mas mantém \n)
  text = text.split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).join('\n')
  return text.trim()
}

/** Parse + valida JSON do classificador. Lança erro se shape errada. */
function parseClassifierJson(raw: string): Omit<ClassificationResult, 'llm'> {
  let parsed: Record<string, unknown>
  try {
    // Modelo às vezes envolve em ```json ... ``` mesmo com jsonMode
    let cleaned = raw.trim()
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    }
    parsed = JSON.parse(cleaned)
  } catch (e) {
    throw new BadRequestException(`Classificador retornou JSON inválido: ${(e as Error).message} | raw=${raw.slice(0, 200)}`)
  }

  const intent    = String(parsed.intent    ?? '') as ClassifierIntent
  const sentiment = String(parsed.sentiment ?? '') as ClassifierSentiment
  const urgency   = String(parsed.urgency   ?? '') as ClassifierUrgency
  const risk      = String(parsed.risk      ?? '') as ClassifierRisk

  if (!CLASSIFIER_INTENTS.includes(intent))       throw new BadRequestException(`intent inválido: ${intent}`)
  if (!CLASSIFIER_SENTIMENTS.includes(sentiment)) throw new BadRequestException(`sentiment inválido: ${sentiment}`)
  if (!CLASSIFIER_URGENCIES.includes(urgency))    throw new BadRequestException(`urgency inválido: ${urgency}`)
  if (!CLASSIFIER_RISKS.includes(risk))           throw new BadRequestException(`risk inválido: ${risk}`)

  return {
    intent,
    sentiment,
    urgency,
    risk,
    canAutoReply: false, // SEMPRE false no MVP 1, ignora o que o modelo disse
  }
}
