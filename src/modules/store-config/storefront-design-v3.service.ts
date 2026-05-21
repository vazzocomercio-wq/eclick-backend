import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'
import type { StorefrontDesignV3, Section, Block } from './storefront-design-v3.types'
import {
  STOREFRONT_TEMPLATE_V3_MAP,
  DEFAULT_DESIGN_V3,
} from './storefront-design-v3.templates'
import { validateDesignV3 } from './storefront-design-v3.validator'

/**
 * Store Builder v3 — service.
 *
 * Operacoes:
 *  - getDesign      → le design_v3 (fallback DEFAULT_DESIGN_V3)
 *  - saveDesign     → valida + salva
 *  - applyTemplate  → clona template (uuid novo) + salva
 *  - generateDesign → IA gera tema + home a partir de prompt do lojista
 *
 * Multi-tenant: toda operacao recebe orgId. store_config.organization_id
 * e UNIQUE (1 loja por org no MVP).
 */
@Injectable()
export class StorefrontDesignV3Service {
  private readonly logger = new Logger(StorefrontDesignV3Service.name)

  constructor(private readonly llm: LlmService) {}

  /** Le o design v3 da loja (DEFAULT_DESIGN_V3 se null). */
  async getDesign(orgId: string): Promise<StorefrontDesignV3> {
    const { data, error } = await supabaseAdmin
      .from('store_config')
      .select('design_v3')
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) {
      this.logger.error(`[v3] getDesign org=${orgId} ${error.message}`)
      throw new BadRequestException('Falha ao carregar design da loja.')
    }
    if (!data?.design_v3) return DEFAULT_DESIGN_V3
    return validateDesignV3(data.design_v3, DEFAULT_DESIGN_V3)
  }

  /** Valida + salva design v3 em store_config.design_v3. */
  async saveDesign(orgId: string, raw: unknown): Promise<StorefrontDesignV3> {
    const design = validateDesignV3(raw, DEFAULT_DESIGN_V3)
    const { error } = await supabaseAdmin
      .from('store_config')
      .update({ design_v3: design as unknown as Record<string, unknown> })
      .eq('organization_id', orgId)
    if (error) {
      this.logger.error(`[v3] saveDesign org=${orgId} ${error.message}`)
      throw new BadRequestException('Falha ao salvar design da loja.')
    }
    this.logger.log(`[v3] saveDesign org=${orgId} templateKey=${design.meta.templateKey}`)
    return design
  }

  /** Aplica template — clona e reescreve IDs com randomUUID. */
  async applyTemplate(orgId: string, templateKey: string): Promise<StorefrontDesignV3> {
    const template = STOREFRONT_TEMPLATE_V3_MAP[templateKey]
    if (!template) {
      throw new NotFoundException(`Template "${templateKey}" nao encontrado.`)
    }
    const cloned = cloneDesignWithFreshIds(template.design)
    return this.saveDesign(orgId, cloned)
  }

  /**
   * Gera tema + sections da home a partir de um prompt do lojista.
   *
   * Output da IA: `{ theme: ThemeV3, home_sections: Section[] }` parcial.
   * Mergeia com DEFAULT_DESIGN_V3 (globals/product/collection/cart/checkout
   * mantidos do template). Validator garante shape final.
   *
   * `templateKey` opcional pra escolher template base (em vez do DEFAULT).
   */
  async generateDesign(orgId: string, input: { prompt: string; templateKey?: string }): Promise<StorefrontDesignV3> {
    const prompt = (input.prompt ?? '').trim()
    if (prompt.length < 3) {
      throw new BadRequestException('Descreva como você quer a loja (pelo menos algumas palavras).')
    }

    const baseTpl = input.templateKey ? STOREFRONT_TEMPLATE_V3_MAP[input.templateKey] : undefined
    const base = baseTpl?.design ?? DEFAULT_DESIGN_V3
    const storeName = await this.loadStoreName(orgId)

    const userPrompt = [
      `Loja: "${storeName}"`,
      `Descrição do lojista: ${prompt}`,
      '',
      'Gere a receita de design em JSON conforme o formato do system prompt.',
    ].join('\n')

    let raw: string
    try {
      const out = await this.llm.generateText({
        orgId,
        feature:      'storefront_design',
        systemPrompt: SYSTEM_PROMPT_V3,
        userPrompt,
        jsonMode:     true,
        maxTokens:    7000,
        temperature:  0.7,
      })
      raw = out.text
      this.logger.log(`[v3] generateDesign org=${orgId} model=${out.model} cost=$${out.costUsd.toFixed(4)} fallback=${out.fallbackUsed}`)
    } catch (e) {
      this.logger.error(`[v3] LLM falhou: ${(e as Error).message}`)
      throw new BadRequestException('A IA não conseguiu gerar o design agora. Tente de novo em instantes.')
    }

    const parsed = parseJsonLoose(raw)
    if (!parsed || typeof parsed !== 'object') {
      this.logger.warn(`[v3] resposta nao-JSON: ${raw.slice(0, 200)}`)
      throw new BadRequestException('A IA retornou um formato inesperado. Tente reformular a descrição.')
    }
    const p = parsed as { theme?: unknown; home_sections?: unknown }

    // Monta design completo: base do template + theme/home da IA.
    const merged: StorefrontDesignV3 = {
      ...base,
      theme: { ...base.theme, ...(p.theme && typeof p.theme === 'object' ? p.theme : {}) } as StorefrontDesignV3['theme'],
      pages: {
        ...base.pages,
        home: {
          ...base.pages.home,
          sections: Array.isArray(p.home_sections) && p.home_sections.length > 0
            ? (p.home_sections as Section[])
            : base.pages.home.sections,
        },
      },
      meta: { templateKey: base.meta.templateKey, updatedAt: new Date().toISOString() },
    }
    // Reescreve IDs (IA pode emitir IDs duplicados/colidir com outras lojas).
    const fresh = cloneDesignWithFreshIds(merged)
    return this.saveDesign(orgId, fresh)
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
}

// ─────────────────────────────────────────────────────────────────────────
// SYSTEM_PROMPT v3 — IA emite { theme, home_sections }
// ─────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_V3 = `Você é um designer de e-commerce especializado em vitrines virtuais premium (estilo Shopify OS 2.0). Sua tarefa: criar a "receita de design" v3 de uma loja online — um JSON estruturado.

Responda SOMENTE com o objeto JSON. Sem markdown, sem comentários, sem texto antes ou depois.

FORMATO:
{
  "theme": {
    "mode": "dark" | "light",
    "colors": {
      "background": "#rrggbb", "surface": "#rrggbb", "primary": "#rrggbb",
      "text": "#rrggbb", "textMuted": "#rrggbb", "border": "#rrggbb",
      "dark": "#rrggbb", "watermark": "#rrggbb", "onAccent": "#rrggbb"
    },
    "fontPair": "elegant" | "modern" | "bold" | "classic" | "editorial" | "playful",
    "radius": "none" | "sm" | "md" | "lg" | "full",
    "density": "compact" | "cozy" | "spacious",
    "effects": { "scrollReveal": true, "watermarks": true, "parallaxTilt": true, "hoverRollover": true },
    "buttons": { "style": "solid" | "outline" | "pill" | "sharp", "weight": "normal" | "bold" }
  },
  "home_sections": [ /* lista de sections — ver abaixo */ ]
}

CORES (regras):
- background, surface, primary, text, textMuted, border: paleta principal coesa
- dark: fundo escuro de faixas (announcement, marquee) — quase preto ou cor mais escura da marca
- watermark: cor muito sutil (próxima ao background) — texto gigante ao fundo
- onAccent: cor do texto sobre "primary" (ex.: dentro de botões) — contraste FORTE com primary

SECTIONS — cada item de home_sections é um objeto com a estrutura COMUM:
{
  "id": "string-unico",
  "type": "<tipo>",
  "settings": { /* props específicos do tipo */ },
  "blocks": [ /* blocos internos, vazio se não usar */ ],
  "visibility": { "desktop": true, "mobile": true },
  "spacing": { "paddingTop": 60, "paddingBottom": 60, "marginTop": 0, "marginBottom": 0 },
  "background": { "kind": "none" }
}

TIPOS DISPONÍVEIS pra home (use 6-9 deles em ordem que faça sentido):

1. announcementBar — settings: { "message":"...", "ctaLabel":"...", "ctaHref":"#", "countdownTo": null, "dismissible": false }
2. slider — settings: { "autoplay": true, "interval": 6, "showDots": true, "showArrows": true, "effect": "fade", "height": "lg" }
   blocks: array de "slide" com { "imageUrl":"", "headline":"...", "subheadline":"...", "ctaLabel":"...", "ctaHref":"#", "textColor":"#fff", "textAlign":"left" }
3. hero — settings: { "layout": "split"|"centered"|"overlay", "height": "md"|"lg"|"fullscreen", "textAlign": "left"|"center" }
   blocks: heading + subheading + paragraph + button
4. productCarousel — settings: { "title":"...", "source": {"kind":"bestsellers"|"storefront"|"newest"|"promo"}, "limit": 12, "autoplay": false, "cardStyle": "detailed" }
5. productGrid — settings: { "title":"...", "source": {"kind":"storefront"}, "columns": {"mobile":2,"tablet":3,"desktop":4}, "limit": 24, "showFilters": false, "showSort": false, "cardStyle": "detailed" }
6. collectionGrid — settings: { "title":"...", "columns": {"mobile":2,"tablet":3,"desktop":4}, "collections": [{"collectionId":"{{collection.x}}","label":"Nome","imageUrl":""}] }
7. imageWithText — settings: { "imageUrl":"", "imageSide":"left"|"right", "title":"...", "body":"...", "ctaLabel":"...", "ctaHref":"#" }
8. marquee — settings: { "items":["Frase 1","Frase 2"], "speed": "normal", "direction": "left" }
9. testimonials — settings: { "title":"...", "layout": "grid"|"carousel", "items": [{"id":"1","name":"Nome","text":"Depoimento","rating": 5}] }
10. faq — settings: { "title":"...", "items": [{"id":"1","question":"...","answer":"..."}] }
11. newsletter — settings: { "title":"...", "description":"...", "ctaLabel":"Inscrever", "placeholder":"seu@email.com", "successMessage":"Obrigado!" }

BLOCKS aceitos dentro de hero:
- heading: { "text":"...", "level": 1|2, "align": "left"|"center" }
- subheading: { "text":"...", "align": "left"|"center" }
- paragraph: { "text":"...", "align": "left"|"center" }
- button: { "label":"...", "href":"/produtos", "style":"primary"|"secondary", "size":"md"|"lg", "newTab": false }
- badge: { "text":"NOVO", "color":"primary" }

Cada block precisa de "id": "string-unico", "type":"...", "settings": {...}

REGRAS:
- TODO "imageUrl" deve ser string vazia "" — imagens entram depois. NUNCA invente URLs.
- collectionId pode usar placeholder "{{collection.xyz}}".
- Use 6-9 sections na home, sempre comecando com announcementBar OU slider OU hero.
- Idealmente inclua: 1 hero/slider, 1-2 productCarousel/productGrid, 1 collectionGrid, 1 imageWithText, 1 newsletter ou testimonials.
- ID pode ser string aleatoria (ex: "sec-001"). Backend reescreve com uuid.
- Paleta COESA e harmônica; mode "dark" → background escuro, "light" → claro; contraste legível entre text e background.
- fontPair/radius/density combinando com o estilo (luxo → elegant ou editorial + sm + spacious; jovem → bold + lg + cozy).
- TODOS os textos em português do Brasil, com acentuação correta.`

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim()
  // Tenta direto
  try { return JSON.parse(trimmed) } catch {}
  // Extrai entre crases (markdown code block)
  const m = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (m) {
    try { return JSON.parse(m[1]) } catch {}
  }
  // Extrai entre primeiro { e ultimo }
  const open = trimmed.indexOf('{')
  const close = trimmed.lastIndexOf('}')
  if (open >= 0 && close > open) {
    try { return JSON.parse(trimmed.slice(open, close + 1)) } catch {}
  }
  return null
}

function cloneDesignWithFreshIds(d: StorefrontDesignV3): StorefrontDesignV3 {
  return {
    version: 3,
    theme: structuredClone(d.theme),
    globals: {
      header: refreshSectionIds(d.globals.header),
      footer: refreshSectionIds(d.globals.footer),
    },
    pages: {
      home:       { ...d.pages.home,       sections: d.pages.home.sections.map(refreshSectionIds) },
      product:    { ...d.pages.product,    sections: d.pages.product.sections.map(refreshSectionIds) },
      collection: { ...d.pages.collection, sections: d.pages.collection.sections.map(refreshSectionIds) },
      cart:       { ...d.pages.cart,       sections: d.pages.cart.sections.map(refreshSectionIds) },
      checkout:   { ...d.pages.checkout,   sections: d.pages.checkout.sections.map(refreshSectionIds) },
    },
    meta: { templateKey: d.meta.templateKey, updatedAt: new Date().toISOString() },
  }
}

function refreshSectionIds<T extends Section>(s: T): T {
  const cloned = structuredClone(s) as T
  ;(cloned as Section).id = randomUUID()
  ;(cloned as Section).blocks = (cloned as Section).blocks.map((b: Block) => ({
    ...b, id: randomUUID(),
  })) as Section['blocks']
  return cloned
}
