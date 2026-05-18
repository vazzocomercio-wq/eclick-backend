import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import axios from 'axios'
import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'
import { CanvaOauthService } from '../canva-oauth/canva-oauth.service'
import type { GenerateTextOutput, GenerateImageOutput } from '../ai/types'
import type { StorefrontDesign, HeroSection, FontPair } from './storefront-design.types'
import { STOREFRONT_TEMPLATE_MAP, DEFAULT_DESIGN } from './storefront-design.templates'
import { validateDesign } from './storefront-design.validator'

/** Bucket publico do Supabase Storage pras imagens de banner da loja. */
const STOREFRONT_BUCKET = 'storefront-assets'

/**
 * Loja Propria — Fase 2: geracao da receita de design por IA.
 *
 * O lojista descreve a loja (prompt) e opcionalmente escolhe um modelo de
 * inspiracao; o Claude monta um StorefrontDesign completo. O resultado e
 * validado (validateDesign) e salvo em store_config.design. O renderizador
 * do frontend (Fase 1) le essa coluna.
 */

const SYSTEM_PROMPT = `Você é um designer de e-commerce especializado em criar lojas virtuais bonitas e coerentes.

Sua tarefa: criar a "receita de design" de uma loja — um objeto JSON — conforme o pedido do lojista.

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
    "fontPair": "elegant" | "modern" | "bold" | "classic" | "editorial" | "playful",
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

  constructor(
    private readonly llm: LlmService,
    private readonly canva: CanvaOauthService,
  ) {}

  /** Lista os designs do Canva do usuario (pra usar como inspiracao visual). */
  async listCanvaDesigns(
    orgId: string,
    query?: string,
  ): Promise<Array<{ id: string; title: string; thumbnailUrl: string | null }>> {
    return this.canva.listDesigns(orgId, query)
  }

  /** Gera o design da loja a partir de um design do Canva (export PNG -> visao). */
  async generateFromCanvaDesign(
    orgId: string,
    input: { designId: string; prompt?: string },
  ): Promise<{ design: StorefrontDesign }> {
    const designId = (input.designId ?? '').trim()
    if (!designId) throw new BadRequestException('Escolha um design do Canva.')
    const imageBase64 = await this.canva.exportDesignAsBase64(orgId, designId)
    return this.generateFromImage(orgId, {
      imageBase64,
      imageMimeType: 'image/png',
      prompt:        input.prompt,
    })
  }

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

  /** Gera a receita de design analisando uma imagem de referencia (visao). */
  async generateFromImage(
    orgId: string,
    input: { imageBase64: string; imageMimeType?: string; prompt?: string },
  ): Promise<{ design: StorefrontDesign }> {
    const b64 = (input.imageBase64 ?? '').trim()
    if (b64.length < 100) {
      throw new BadRequestException('Envie uma imagem de referência válida.')
    }
    const storeName = await this.loadStoreName(orgId)
    const extra = (input.prompt ?? '').trim()

    const userPrompt = [
      `A imagem anexada é uma loja ou site cujo estilo visual o lojista quer reproduzir na loja "${storeName}".`,
      'Analise a paleta de cores, a tipografia, a sensação geral e o tipo de layout da imagem.',
      extra ? `Considere também este pedido do lojista: ${extra}` : '',
      'Gere a receita de design completa em JSON, no mesmo espírito visual da imagem — sem copiar produtos ou textos específicos que apareçam nela.',
    ].filter(Boolean).join('\n')

    const out = await this.callVision(orgId, {
      imageBase64:   b64,
      imageMimeType: input.imageMimeType ?? 'image/jpeg',
      userPrompt,
    })

    const parsed = parseJsonLoose(out.text)
    if (parsed === null) {
      this.logger.warn(`[storefront-design] visão resposta nao-JSON: ${out.text.slice(0, 200)}`)
      throw new BadRequestException('A IA retornou um formato inesperado. Tente de novo.')
    }

    const design = validateDesign(parsed, DEFAULT_DESIGN)
    await this.save(orgId, design)
    this.logger.log(
      `[storefront-design] org=${orgId} gerado por imagem (model=${out.model}, custo=$${out.costUsd.toFixed(4)})`,
    )
    return { design }
  }

  /** Gera a imagem de banner (hero) da loja por IA, faz upload e injeta no design. */
  async generateHeroImage(orgId: string, input: { prompt?: string }): Promise<{ design: StorefrontDesign }> {
    const store = await this.loadStoreForHero(orgId)
    const design = store.design ?? DEFAULT_DESIGN

    const imagePrompt = this.buildHeroImagePrompt({
      storeName:        store.store_name,
      storeDescription: store.store_description,
      design,
      hint:             (input.prompt ?? '').trim() || undefined,
    })

    let img: GenerateImageOutput
    try {
      img = await this.llm.generateImage({
        orgId,
        feature: 'storefront_hero_image',
        prompt:  imagePrompt,
        format:  'wide',
        n:       1,
      })
    } catch (e) {
      this.logger.error(`[storefront-design] geração de banner falhou: ${(e as Error).message}`)
      throw new BadRequestException('A IA não conseguiu gerar o banner agora. Tente de novo em instantes.')
    }

    const first = img.images?.[0]
    if (!first?.b64 && !first?.url) {
      throw new BadRequestException('A IA não retornou nenhuma imagem.')
    }

    const buffer = first.b64
      ? Buffer.from(first.b64, 'base64')
      : Buffer.from(
          (await axios.get<ArrayBuffer>(first.url!, { responseType: 'arraybuffer', timeout: 30_000 })).data,
        )

    const path = `${orgId}/hero/${randomUUID()}.png`
    const { error: upErr } = await supabaseAdmin.storage
      .from(STOREFRONT_BUCKET)
      .upload(path, buffer, { contentType: 'image/png', upsert: false })
    if (upErr) {
      throw new BadRequestException(`Erro ao salvar a imagem do banner: ${upErr.message}`)
    }
    const imageUrl = supabaseAdmin.storage.from(STOREFRONT_BUCKET).getPublicUrl(path).data.publicUrl

    // Injeta a imagem no bloco hero (cria um se nao existir).
    let sections = design.sections.map(s =>
      s.type === 'hero' ? ({ ...s, variant: 'image', imageUrl } as HeroSection) : s,
    )
    if (!sections.some(s => s.type === 'hero')) {
      const newHero: HeroSection = {
        type: 'hero', variant: 'image', imageUrl,
        headline: 'Bem-vindo à loja', subheadline: 'Conheça os nossos produtos.', ctaLabel: 'Ver produtos',
      }
      sections = [...sections, newHero]
    }

    const validated = validateDesign({ ...design, sections }, DEFAULT_DESIGN)
    await this.save(orgId, validated)
    this.logger.log(
      `[storefront-design] org=${orgId} banner gerado (model=${img.model}, custo=$${img.costUsd.toFixed(4)})`,
    )
    return { design: validated }
  }

  private buildHeroImagePrompt(args: {
    storeName: string
    storeDescription: string | null
    design: StorefrontDesign
    hint?: string
  }): string {
    const moodByFont: Record<FontPair, string> = {
      elegant:   'elegant and refined',
      modern:    'modern, clean and minimal',
      bold:      'bold, vibrant and energetic',
      classic:   'classic and timeless',
      editorial: 'editorial and sophisticated',
      playful:   'playful, warm and friendly',
    }
    const mood = moodByFont[args.design.theme.fontPair] ?? 'modern and clean'
    const tone = args.design.theme.mode === 'dark'
      ? 'dark, moody, low-key dramatic lighting'
      : 'bright, airy, soft natural light'
    return [
      `Wide cinematic hero banner background image for the online store "${args.storeName}".`,
      args.storeDescription ? `Store context: ${args.storeDescription}.` : '',
      args.hint ? `Scene: ${args.hint}.` : 'A tasteful ambient lifestyle scene that fits the store.',
      `Visual style: ${mood}; ${tone} color palette.`,
      'Composition with generous empty negative space for a text overlay, soft depth of field.',
      'Absolutely NO text, NO words, NO letters, NO logos anywhere in the image.',
      'High-end professional e-commerce photography, photorealistic.',
    ].filter(Boolean).join(' ')
  }

  private async loadStoreForHero(orgId: string): Promise<{
    store_name: string
    store_description: string | null
    design: StorefrontDesign | null
  }> {
    const { data } = await supabaseAdmin
      .from('store_config')
      .select('store_name, store_description, design')
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!data) {
      throw new BadRequestException('Configure sua loja primeiro em Config da Loja.')
    }
    return data as { store_name: string; store_description: string | null; design: StorefrontDesign | null }
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

  private async callVision(
    orgId: string,
    args: { imageBase64: string; imageMimeType: string; userPrompt: string },
  ): Promise<GenerateTextOutput> {
    try {
      return await this.llm.analyzeImage({
        orgId,
        feature:       'storefront_design',
        imageBase64:   args.imageBase64,
        imageMimeType: args.imageMimeType,
        systemPrompt:  SYSTEM_PROMPT,
        userPrompt:    args.userPrompt,
        jsonMode:      true,
        maxTokens:     2500,
      })
    } catch (e) {
      this.logger.error(`[storefront-design] visão falhou: ${(e as Error).message}`)
      throw new BadRequestException('A IA não conseguiu analisar a imagem agora. Tente outra imagem ou tente de novo.')
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
