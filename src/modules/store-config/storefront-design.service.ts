import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'
import type { GenerateTextOutput } from '../ai/types'
import type { StorefrontDesign } from './storefront-design.types'
import { STOREFRONT_TEMPLATE_MAP, DEFAULT_DESIGN } from './storefront-design.templates'
import { validateDesign } from './storefront-design.validator'

/**
 * Loja Propria — Fase 2: geracao da receita de design por IA.
 *
 * O lojista descreve a loja (prompt) e opcionalmente escolhe um modelo de
 * inspiracao; o Claude monta um StorefrontDesign completo. O resultado e
 * validado (validateDesign) e salvo em store_config.design. O renderizador
 * do frontend (Fase 1) le essa coluna.
 */

const SYSTEM_PROMPT = `Você é um designer de e-commerce especializado em criar lojas virtuais bonitas e coerentes.

Sua tarefa: a partir da descrição do lojista, criar a "receita de design" da loja — um objeto JSON.

Responda SOMENTE com o objeto JSON. Sem markdown, sem comentários, sem texto antes ou depois.

FORMATO EXATO:
{
  "version": 1,
  "theme": {
    "mode": "dark" ou "light",
    "colors": {
      "background": "#rrggbb",  // fundo da página
      "surface": "#rrggbb",     // fundo de cards e blocos
      "primary": "#rrggbb",     // cor de destaque (botões, preço, links)
      "text": "#rrggbb",        // texto forte
      "textMuted": "#rrggbb",   // texto secundário
      "border": "#rrggbb"       // bordas e divisórias
    },
    "fontPair": "elegant" | "modern" | "bold" | "classic",
    "radius": "none" | "sm" | "md" | "lg",
    "density": "compact" | "cozy" | "spacious"
  },
  "sections": [ /* lista ordenada de blocos, ver abaixo */ ],
  "product": {
    "gallery": "side" ou "top",
    "showAttributes": true ou false,
    "ctaMode": "whatsapp"
  }
}

BLOCOS (cada item de "sections" é um objeto):
- {"type":"header","variant":"minimal"|"centered"|"overlay"}
- {"type":"hero","variant":"gradient"|"image"|"split","headline":"...","subheadline":"...","ctaLabel":"..."}
- {"type":"productGrid","variant":"compact"|"elevated"|"editorial","title":"...","columns":{"mobile":1 ou 2,"tablet":2 a 4,"desktop":2 a 4}}
- {"type":"about","variant":"simple"|"banner","title":"...","body":"..."}
- {"type":"footer","variant":"minimal"|"full"}

REGRAS:
- "sections" deve conter, NESTA ORDEM: 1 header, 1 hero, 1 productGrid, opcionalmente 1 about, e 1 footer.
- As 6 cores devem formar uma paleta COESA e harmônica. mode "dark" exige background escuro; "light" exige background claro. Garanta contraste legível entre "text" e "background".
- Escolha fontPair, radius e density que combinem com o estilo pedido (ex.: loja de luxo → elegant + sm + spacious; loja jovem → bold + lg + cozy).
- TODOS os textos (headline, subheadline, ctaLabel, title, body) em português do Brasil, com acentuação correta.
- headline: curto e marcante (3 a 6 palavras). subheadline: 1 frase. ctaLabel: 2 a 3 palavras.
- Cores em hexadecimal de 6 dígitos (#rrggbb).
- "ctaMode" deve ser sempre "whatsapp".`

interface GenerateInput {
  prompt:        string
  inspirationId?: string
}

@Injectable()
export class StorefrontDesignService {
  private readonly logger = new Logger(StorefrontDesignService.name)

  constructor(private readonly llm: LlmService) {}

  /** Gera a receita de design via IA e salva em store_config.design. */
  async generateDesign(orgId: string, input: GenerateInput): Promise<{ design: StorefrontDesign }> {
    const prompt = (input.prompt ?? '').trim()
    if (prompt.length < 3) {
      throw new BadRequestException('Descreva como você quer a loja (pelo menos algumas palavras).')
    }

    const inspiration = input.inspirationId ? STOREFRONT_TEMPLATE_MAP[input.inspirationId] : undefined
    const base = inspiration ?? DEFAULT_DESIGN
    const storeName = await this.loadStoreName(orgId)

    const userPrompt = this.buildUserPrompt({ prompt, storeName, inspiration })

    const out = await this.callLlm(orgId, userPrompt)

    const parsed = parseJsonLoose(out.text)
    if (parsed === null) {
      this.logger.warn(`[storefront-design] resposta nao-JSON: ${out.text.slice(0, 200)}`)
      throw new BadRequestException('A IA retornou um formato inesperado. Tente reformular a descrição.')
    }

    const design = validateDesign(parsed, base)
    await this.save(orgId, design)
    this.logger.log(
      `[storefront-design] org=${orgId} gerado (model=${out.model}, custo=$${out.costUsd.toFixed(4)}, fallback=${out.fallbackUsed})`,
    )
    return { design }
  }

  /** Salva um design escolhido/ajustado direto (ex.: galeria de modelos da UI). */
  async saveDesign(orgId: string, raw: unknown): Promise<{ design: StorefrontDesign }> {
    const design = validateDesign(raw, DEFAULT_DESIGN)
    await this.save(orgId, design)
    return { design }
  }

  private async callLlm(orgId: string, userPrompt: string): Promise<GenerateTextOutput> {
    try {
      return await this.llm.generateText({
        orgId,
        feature:      'storefront_design',
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        jsonMode:     true,
        maxTokens:    2500,
        temperature:  0.7,
      })
    } catch (e) {
      this.logger.error(`[storefront-design] LLM falhou: ${(e as Error).message}`)
      throw new BadRequestException('A IA não conseguiu gerar o design agora. Tente de novo em instantes.')
    }
  }

  private buildUserPrompt(args: {
    prompt: string
    storeName: string
    inspiration?: StorefrontDesign
  }): string {
    const lines = [
      `Loja: "${args.storeName}"`,
      `Descrição do lojista: ${args.prompt}`,
    ]
    if (args.inspiration) {
      lines.push(
        '',
        'Use este modelo como ponto de partida e ajuste conforme a descrição acima:',
        JSON.stringify(args.inspiration),
      )
    }
    lines.push('', 'Gere a receita de design completa em JSON.')
    return lines.join('\n')
  }

  private async loadStoreName(orgId: string): Promise<string> {
    const { data } = await supabaseAdmin
      .from('store_config')
      .select('store_name')
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!data) {
      throw new BadRequestException('Configure sua loja primeiro em Config da Loja.')
    }
    return (data as { store_name: string }).store_name
  }

  private async save(orgId: string, design: StorefrontDesign): Promise<void> {
    const { error } = await supabaseAdmin
      .from('store_config')
      .update({ design })
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro ao salvar o design: ${error.message}`)
  }
}

/** Extrai o objeto JSON da resposta da IA, tolerando fences markdown. */
function parseJsonLoose(text: string): unknown {
  let t = (text ?? '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const first = t.indexOf('{')
  const last = t.lastIndexOf('}')
  if (first >= 0 && last > first) t = t.slice(first, last + 1)
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}
