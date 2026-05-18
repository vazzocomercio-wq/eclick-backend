import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import axios from 'axios'
import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'
import { CanvaOauthService } from '../canva-oauth/canva-oauth.service'
import { CredentialsService } from '../credentials/credentials.service'
import type { GenerateTextOutput, GenerateImageOutput } from '../ai/types'
import type { StorefrontDesign, HeroSection, FontPair, Section } from './storefront-design.types'
import { STOREFRONT_TEMPLATE_MAP, DEFAULT_DESIGN } from './storefront-design.templates'
import { validateDesign } from './storefront-design.validator'

/** Bucket publico do Supabase Storage pras imagens de banner da loja. */
const STOREFRONT_BUCKET = 'storefront-assets'

/** Base de fallback da geracao — o Tema Premium (v2). */
const PREMIUM_BASE: StorefrontDesign = STOREFRONT_TEMPLATE_MAP['editorial_premium'] ?? DEFAULT_DESIGN

/**
 * Loja Propria — Fase 2: geracao da receita de design por IA.
 *
 * O lojista descreve a loja (prompt) e opcionalmente escolhe um modelo de
 * inspiracao; o Claude monta um StorefrontDesign completo. O resultado e
 * validado (validateDesign) e salvo em store_config.design. O renderizador
 * do frontend (Fase 1) le essa coluna.
 */

const SYSTEM_PROMPT = `Você é um designer de e-commerce especializado em lojas virtuais premium, no estilo de temas editoriais sofisticados (visual de revista, com efeitos e seções ricas).

Sua tarefa: criar a "receita de design" de uma loja — um objeto JSON — conforme o pedido do lojista.

Responda SOMENTE com o objeto JSON. Sem markdown, sem comentários, sem texto antes ou depois.

FORMATO:
{
  "version": 2,
  "theme": {
    "mode": "dark" | "light",
    "colors": {
      "background": "#rrggbb", "surface": "#rrggbb", "primary": "#rrggbb",
      "text": "#rrggbb", "textMuted": "#rrggbb", "border": "#rrggbb",
      "dark": "#rrggbb", "watermark": "#rrggbb", "onAccent": "#rrggbb"
    },
    "fontPair": "elegant" | "modern" | "bold" | "classic" | "editorial" | "playful",
    "radius": "none" | "sm" | "md" | "lg",
    "density": "compact" | "cozy" | "spacious",
    "effects": { "scrollReveal": true, "watermarks": true, "parallaxTilt": true, "hoverRollover": true }
  },
  "sections": [ /* ver abaixo */ ],
  "product": { "gallery": "side" | "top", "showAttributes": true | false, "ctaMode": "whatsapp" }
}

CORES:
- background, surface, primary, text, textMuted, border: paleta principal coesa.
- dark: fundo escuro das faixas (announcement, marquee) — quase preto ou a cor mais escura da marca.
- watermark: cor MUITO sutil (bem próxima do background) — texto gigante de marca ao fundo das seções.
- onAccent: cor do texto sobre a cor "primary" (ex.: dentro de botões) — contraste FORTE com primary.

SEÇÕES — cada item de "sections" é um objeto. Monte uma home rica nesta ordem lógica:
1. {"type":"announcementBar","message":"...","countdownTo":null}
2. {"type":"siteHeader","variant":"split"|"centered","sticky":true,"showSearch":true,"showCart":true,"nav":[{"label":"...","href":"#"}]}
3. {"type":"heroPortrait","watermark":"PALAVRA","headline":"...","subheadline":"...","ctaLabel":"...","slides":[{"imageUrl":"","label":"..."},{"imageUrl":"","label":"..."},{"imageUrl":"","label":"..."}]}
4. MEIO — escolha de 4 a 7 das opções abaixo, em ordem que faça sentido:
   - {"type":"marquee","items":["frase curta 1","frase curta 2","frase curta 3"]}
   - {"type":"productShowcase","layout":"carousel"|"grid","title":"...","watermark":"PALAVRA","source":"storefront","collectionId":null}
   - {"type":"categoryGrid","title":"...","watermark":"PALAVRA","categories":[{"label":"...","imageUrl":""}]}
   - {"type":"editorialSplit","title":"...","body":"...","imageUrl":"","imageSide":"left"|"right","ctaLabel":"...","ctaHref":"#"}
   - {"type":"tiltBanner","imageUrl":"","watermark":"PALAVRA","headline":"..."}
   - {"type":"fullBanner","imageUrl":"","headline":"...","subheadline":"...","ctaLabel":"...","ctaHref":"#"}
   - {"type":"imageHotspot","title":"...","imageUrl":"","hotspots":[{"xPct":30,"yPct":40,"label":"..."}]}
5. {"type":"siteFooter","variant":"columns","newsletter":true,"columns":[{"title":"...","links":[{"label":"...","href":"#"}]}]}

REGRAS:
- "version" deve ser 2.
- Inclua SEMPRE: 1 announcementBar, 1 siteHeader, 1 heroPortrait, NO MÍNIMO 2 productShowcase e 1 siteFooter. No meio, varie de 4 a 7 seções.
- TODO campo "imageUrl" deve ser string vazia "" — as imagens entram depois. NUNCA invente URLs.
- Em "hotspots" use só "label" (sem productId). "watermark" é uma palavra curta em CAIXA ALTA (ex.: "LOJA", "ESTILO").
- Todo "href" (nav, links do rodapé, ctaHref) deve ser uma âncora simples "#".
- Paleta COESA e harmônica; mode "dark" → background escuro, "light" → claro; contraste legível entre text e background.
- fontPair/radius/density combinando com o estilo pedido (luxo → elegant ou editorial + sm + spacious; jovem → bold + lg + cozy).
- TODOS os textos em português do Brasil, com acentuação correta. headline curto e marcante; subheadline 1 frase; ctaLabel 2 a 3 palavras.
- Cores em hexadecimal de 6 dígitos (#rrggbb). "ctaMode" sempre "whatsapp".`

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
    private readonly credentials: CredentialsService,
  ) {}

  /** Gera o design da loja a partir de um screenshot de uma URL de referencia. */
  async generateFromUrl(
    orgId: string,
    input: { url: string; prompt?: string },
  ): Promise<{ design: StorefrontDesign }> {
    const url = (input.url ?? '').trim()
    if (!/^https?:\/\/.+\..+/i.test(url)) {
      throw new BadRequestException('Informe uma URL válida (começando com http:// ou https://).')
    }
    const imageBase64 = await this.screenshotUrl(orgId, url)
    return this.generateFromImage(orgId, {
      imageBase64,
      imageMimeType: 'image/jpeg',
      prompt:        input.prompt,
    })
  }

  /** Captura um screenshot da URL via ScreenshotOne e devolve em base64. */
  private async screenshotUrl(orgId: string, url: string): Promise<string> {
    const key =
      (await this.credentials.getDecryptedKey(orgId, 'screenshotone', 'SCREENSHOTONE_API_KEY').catch(() => null)) ??
      (await this.credentials.getDecryptedKey(null, 'screenshotone', 'SCREENSHOTONE_API_KEY').catch(() => null))
    if (!key) {
      throw new BadRequestException(
        'Inspiração por URL não configurada — adicione a chave do ScreenshotOne nas Configurações.',
      )
    }
    const params = new URLSearchParams({
      access_key:           key,
      url,
      format:               'jpg',
      viewport_width:       '1280',
      viewport_height:      '900',
      full_page:            'false',
      block_ads:            'true',
      block_cookie_banners: 'true',
      image_quality:        '82',
    })
    try {
      const res = await axios.get<ArrayBuffer>(
        `https://api.screenshotone.com/take?${params.toString()}`,
        { responseType: 'arraybuffer', timeout: 45_000 },
      )
      return Buffer.from(res.data).toString('base64')
    } catch (e) {
      const msg = axios.isAxiosError(e) ? `HTTP ${e.response?.status}` : (e as Error).message
      this.logger.error(`[storefront-design] screenshot da URL falhou: ${msg}`)
      throw new BadRequestException('Não foi possível capturar o site. Verifique a URL e tente de novo.')
    }
  }

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
    const base = inspiration ?? PREMIUM_BASE
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

    const design = validateDesign(parsed, PREMIUM_BASE)
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

    const validated = validateDesign(this.injectHeroImage(design, imageUrl), PREMIUM_BASE)
    await this.save(orgId, validated)
    this.logger.log(
      `[storefront-design] org=${orgId} banner gerado (model=${img.model}, custo=$${img.costUsd.toFixed(4)})`,
    )
    return { design: validated }
  }

  /**
   * Injeta a imagem de banner no design. No v2 procura um banner
   * (tiltBanner/fullBanner) ou o primeiro slide do heroPortrait; no v1
   * preenche o bloco hero. Cria um bloco quando nao existe alvo.
   */
  private injectHeroImage(design: StorefrontDesign, imageUrl: string): StorefrontDesign {
    const sections = [...design.sections]

    if (design.version === 2) {
      const bannerIdx = sections.findIndex(s => s.type === 'tiltBanner' || s.type === 'fullBanner')
      if (bannerIdx >= 0) {
        sections[bannerIdx] = { ...sections[bannerIdx], imageUrl } as Section
      } else {
        const heroIdx = sections.findIndex(s => s.type === 'heroPortrait')
        if (heroIdx >= 0) {
          const hp = sections[heroIdx] as Extract<Section, { type: 'heroPortrait' }>
          const slides = hp.slides.length > 0
            ? hp.slides.map((sl, i) => (i === 0 ? { ...sl, imageUrl } : sl))
            : [{ imageUrl }]
          sections[heroIdx] = { ...hp, slides }
        } else {
          sections.push({ type: 'fullBanner', imageUrl, headline: 'Destaque da loja' })
        }
      }
      return { ...design, sections }
    }

    // v1 — bloco hero com imagem.
    let v1 = sections.map(s =>
      s.type === 'hero' ? ({ ...s, variant: 'image', imageUrl } as HeroSection) : s,
    )
    if (!v1.some(s => s.type === 'hero')) {
      v1 = [...v1, {
        type: 'hero', variant: 'image', imageUrl,
        headline: 'Bem-vindo à loja', subheadline: 'Conheça os nossos produtos.', ctaLabel: 'Ver produtos',
      }]
    }
    return { ...design, sections: v1 }
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
        maxTokens:    7000,
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
        maxTokens:     7000,
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
