/** Prompts da esteira IA Criativo (E1).
 *
 *  Dois prompts:
 *   1. PRODUCT_ANALYSIS_PROMPT — Vision sobre a imagem do produto
 *   2. buildListingPrompt      — geração do anúncio textual completo
 */

import { getMarketplaceRules, type Marketplace } from './creative.marketplace-rules'

// ============================================================
// 1. Análise da imagem (Vision)
// ============================================================

export const PRODUCT_ANALYSIS_PROMPT = `Você é um especialista em análise de produtos para e-commerce.
Analise esta imagem de produto e retorne APENAS um JSON válido com a seguinte estrutura:

{
  "product_type":     "tipo exato do produto (ex: Organizador de gaveta em plástico)",
  "detected_color":   "cor principal e secundárias",
  "detected_material":"material aparente com nível de confiança",
  "detected_format":  "formato geométrico e dimensões aparentes",
  "key_parts":        ["lista de partes/componentes visíveis"],
  "possible_uses":    ["contextos de uso recomendados"],
  "visual_risks":     ["riscos específicos que a IA de imagem pode cometer ao gerar variações"],
  "suggested_angles": ["ângulos de foto recomendados para o marketplace"],
  "confidence_score": 0.0
}

REGRAS:
- Seja preciso e específico, não genérico
- Em visual_risks, liste problemas reais (ex: "alça pode desaparecer em fundo branco")
- Em suggested_angles, pense como fotógrafo de catálogo
- Se não conseguir identificar algo com certeza, indique baixa confiança em confidence_score
- Retorne APENAS o JSON, sem markdown, sem explicação textual antes ou depois
`

// ============================================================
// 2. Geração do anúncio textual
// ============================================================

export interface ListingPromptInput {
  product: {
    name:             string
    category:         string
    brand?:           string | null
    color?:           string | null
    material?:        string | null
    dimensions?:      Record<string, unknown>
    differentials?:   string[]
    target_audience?: string | null
    ai_analysis?:     Record<string, unknown>
  }
  briefing: {
    target_marketplace: Marketplace
    visual_style:       string
    communication_tone: string
  }
  /** Instrução de ajuste para regenerações (opcional). */
  refinement?: string
}

export function buildListingPrompt(input: ListingPromptInput): string {
  const rules = getMarketplaceRules(input.briefing.target_marketplace)
  const p = input.product

  return `Você é um copywriter especialista em anúncios de marketplace brasileiro.

## PRODUTO
Nome: ${p.name}
Categoria: ${p.category}
Marca: ${p.brand ?? 'Não informada'}
Cor: ${p.color ?? (p.ai_analysis?.detected_color as string | undefined) ?? 'Não informada'}
Material: ${p.material ?? (p.ai_analysis?.detected_material as string | undefined) ?? 'Não informado'}
Medidas: ${JSON.stringify(p.dimensions ?? {})}
Diferenciais: ${(p.differentials ?? []).join(', ') || 'Não informados'}
Público-alvo: ${p.target_audience ?? 'Geral'}

## ANÁLISE VISUAL DA IA
${JSON.stringify(p.ai_analysis ?? {}, null, 2)}

## MARKETPLACE ALVO
${input.briefing.target_marketplace}

## TOM DE COMUNICAÇÃO
${input.briefing.communication_tone}

## ESTILO VISUAL
${input.briefing.visual_style}

## REGRAS DO MARKETPLACE
${rules.title_rules}
- Título: máximo ${rules.max_title_chars} caracteres
- Descrição: entre 500 e ${Math.min(rules.max_description_chars, 2000)} caracteres
- Bullets: entre 5 e 7
- Estilo de bullet: ${describeBulletStyle(rules.bullet_style)}
- Ficha técnica: ${rules.ficha_tecnica_required ? 'OBRIGATÓRIA — mínimo 7 campos' : 'opcional, recomendada'}
- Palavras-chave: 10 a 15, relevantes para busca no marketplace
- FAQ: 5 perguntas reais que compradores fariam

## REGRAS DE QUALIDADE (NÃO NEGOCIÁVEIS)
- NÃO inventar especificações que não existem no produto
- NÃO usar superlativos falsos ("melhor do mundo", "único", "número 1")
- NÃO prometer prazos, garantias ou condições que não foram informadas
- SER honesto com as características reais visíveis na imagem ou nos dados
${input.refinement ? `\n## AJUSTE SOLICITADO\n${input.refinement}` : ''}

Retorne APENAS um JSON válido (sem markdown, sem texto fora do JSON):
{
  "title":                    "título otimizado",
  "subtitle":                 "subtítulo curto (opcional, pode ser vazio)",
  "description":              "descrição comercial completa",
  "bullets":                  ["bullet 1", "bullet 2", "..."],
  "technical_sheet":          { "Material": "...", "Cor": "...", "...": "..." },
  "keywords":                 ["palavra1", "palavra2", "..."],
  "search_tags":              ["tag1", "tag2", "..."],
  "suggested_category":       "categoria sugerida",
  "faq":                      [{ "q": "...", "a": "..." }],
  "commercial_differentials": ["diferencial 1", "diferencial 2", "..."]
}
`
}

function describeBulletStyle(style: 'emoji_prefix' | 'dash_prefix' | 'plain'): string {
  switch (style) {
    case 'emoji_prefix': return 'cada bullet começa com emoji ✅ (ex: "✅ Material premium")'
    case 'dash_prefix':  return 'cada bullet começa com hífen "- " (ex: "- Material premium")'
    case 'plain':        return 'texto puro, sem prefixo (ex: "Material premium")'
  }
}

// ============================================================
// 3. Pipeline de N imagens — gera N prompts coerentes em 1 chamada
// ============================================================

export interface ImagePromptsBuilderInput {
  product: {
    name:             string
    category:         string
    brand?:           string | null
    color?:           string | null
    material?:        string | null
    dimensions?:      Record<string, unknown>
    differentials?:   string[]
    target_audience?: string | null
    ai_analysis?:     Record<string, unknown>
  }
  briefing: {
    target_marketplace: Marketplace
    visual_style:       string
    environment:        string | null
    custom_environment: string | null
    background_color:   string
    use_logo:           boolean
    communication_tone: string
    image_count:        number
  }
  count: number
}

/**
 * Pede pro Sonnet gerar N prompts em 1 chamada — preserva contexto entre as
 * posições (hero → lifestyle → close-up → in-use → packaging → infographic
 * → scale → multi-angle → top-down → 3/4 view, ajustado por count).
 * Retorna array de strings em inglês (gpt-image-1 funciona melhor em EN).
 */
export function buildImagePromptsRequest(input: ImagePromptsBuilderInput): string {
  const p = input.product
  const b = input.briefing
  const env = b.environment === 'custom' ? (b.custom_environment ?? 'neutral') : (b.environment ?? 'neutral')

  return `You are a senior product photographer + e-commerce art director.

Generate ${input.count} distinct image prompts for the product below, designed for a ${b.target_marketplace} listing. The product image will be passed as REFERENCE to the image model — do NOT change the product itself, only the angle, framing, environment, and lighting.

## PRODUCT
Name:            ${p.name}
Category:        ${p.category}
Brand:           ${p.brand ?? 'N/A'}
Color:           ${p.color ?? (p.ai_analysis?.detected_color as string | undefined) ?? 'N/A'}
Material:        ${p.material ?? (p.ai_analysis?.detected_material as string | undefined) ?? 'N/A'}
Dimensions:      ${JSON.stringify(p.dimensions ?? {})}
Differentials:   ${(p.differentials ?? []).join(', ') || 'N/A'}
Target audience: ${p.target_audience ?? 'general'}

## AI VISUAL ANALYSIS
${JSON.stringify(p.ai_analysis ?? {}, null, 2)}

## BRIEFING
Visual style:    ${b.visual_style}
Environment:     ${env}
Background:      ${b.background_color}
Logo allowed:    ${b.use_logo ? 'yes — discreet, brand-consistent' : 'no — strictly no text/logos/watermarks'}
Tone:            ${b.communication_tone}

## VARIATION STRATEGY (cycle through, adjust to count=${input.count})
1. Hero shot — clean, centered, marketplace-cover quality
2. Lifestyle — product in real-world use, in the briefing environment
3. Detail close-up — texture, finish, premium feel
4. In-use — hands or context interacting with the product
5. Multi-angle composite — front + side or front + 3/4
6. Top-down flat lay — overhead view, organized
7. Scale reference — product next to common object for size feel
8. Packaging or unboxing scene
9. Infographic-style — empty space for text overlays (don't add text)
10. Side or 3/4 view with depth — soft shadows, dimensional

If count < 10, prioritize positions 1-3-2-4-5 in that order (most impactful first).
If count > 10, repeat with style/lighting variations.

## RULES
- Each prompt: 1-3 sentences, English, optimized for gpt-image-1 image-edit mode
- ALWAYS reference the product positively (e.g., "the product shown in the reference image")
- Specify lighting (e.g., "soft natural daylight", "studio softbox")
- Specify camera angle (e.g., "eye-level", "45-degree top-down", "macro 50mm")
- Match the visual_style strictly (premium ≠ promocional)
- Background color guideline: ${b.background_color}${b.use_logo ? '' : '\n- DO NOT add text, watermarks, logos, or branding overlays'}
- Avoid generic adjectives ("beautiful", "amazing") — use concrete photographic terms

Return ONLY a JSON array of exactly ${input.count} strings, no markdown, no comments:
[
  "prompt 1",
  "prompt 2"
]`
}

// ============================================================
// 4. Pipeline de vídeo — gera N prompts coerentes pra Kling image2video
// ============================================================

export interface VideoPromptsBuilderInput {
  product:       ImagePromptsBuilderInput['product']
  briefing:      ImagePromptsBuilderInput['briefing']
  count:         number
  durationSec:   5 | 10
  aspectRatio:   '1:1' | '16:9' | '9:16'
}

/**
 * Pede pro Sonnet gerar N prompts de motion video (1-5) em 1 chamada.
 * Kling responde melhor a prompts em inglês descrevendo movimento de
 * câmera + ação + ambiente. Sem texto/logos no vídeo.
 */
export function buildVideoPromptsRequest(input: VideoPromptsBuilderInput): string {
  const p = input.product
  const b = input.briefing
  const env = b.environment === 'custom' ? (b.custom_environment ?? 'neutral') : (b.environment ?? 'neutral')

  return `You are a senior motion-graphics director crafting short product videos for marketplace listings.

The product image will be passed as the FIRST FRAME (image2video). Your prompts describe what HAPPENS during the ${input.durationSec}-second clip — camera motion, ambient lighting changes, micro-actions. The product itself does NOT change shape or color.

## PRODUCT
Name:            ${p.name}
Category:        ${p.category}
Color:           ${p.color ?? (p.ai_analysis?.detected_color as string | undefined) ?? 'N/A'}
Material:        ${p.material ?? (p.ai_analysis?.detected_material as string | undefined) ?? 'N/A'}
Differentials:   ${(p.differentials ?? []).join(', ') || 'N/A'}

## AI VISUAL ANALYSIS
${JSON.stringify(p.ai_analysis ?? {}, null, 2)}

## BRIEFING
Visual style:    ${b.visual_style}
Environment:     ${env}
Tone:            ${b.communication_tone}
Aspect ratio:    ${input.aspectRatio}
Duration:        ${input.durationSec}s

## VARIATION STRATEGY (cycle through, ${input.count} total)
1. Cinemagraph hero — subtle motion (dust particles, light shift), product centered, camera barely moves
2. Slow zoom-in detail — camera slowly approaches, reveals texture/finish
3. Product rotation — turntable feel, 360° if possible in ${input.durationSec}s
4. Hands present — hands gently enter frame, lift or rotate the product
5. Action / use — context of use (cooking, organizing, applying, etc.)

## RULES
- Each prompt: 1-3 sentences, English, optimized for Kling image2video
- ALWAYS describe motion explicitly (camera move, lighting shift, action)
- Specify pace: "slow", "smooth", "gentle" — avoid frenetic motion
- Match visual_style strictly (premium = elegant slow motion; promocional = bolder energy)
- DO NOT add text, watermarks, logos, or branding overlays
- DO NOT change product shape, color, or appearance
- Avoid generic adjectives — use concrete cinematographic terms

Return ONLY a JSON array of exactly ${input.count} strings, no markdown, no comments:
[
  "prompt 1",
  "prompt 2"
]`
}

// ============================================================
// 5. Variante por marketplace (re-aproveita o anúncio base)
// ============================================================

export function buildVariantPrompt(
  baseListing: {
    title:       string
    description: string
    bullets:     string[]
  },
  targetMarketplace: Marketplace,
): string {
  const rules = getMarketplaceRules(targetMarketplace)
  return `Você é um copywriter de marketplace. Adapte o anúncio abaixo para ${targetMarketplace}, respeitando as regras do marketplace.

## ANÚNCIO BASE
Título: ${baseListing.title}
Descrição: ${baseListing.description}
Bullets:
${baseListing.bullets.map((b, i) => `  ${i + 1}. ${b}`).join('\n')}

## REGRAS DO MARKETPLACE ALVO (${targetMarketplace})
${rules.title_rules}
- Título: máximo ${rules.max_title_chars} caracteres
- Descrição: máximo ${Math.min(rules.max_description_chars, 2000)} caracteres
- Estilo de bullet: ${describeBulletStyle(rules.bullet_style)}

Retorne APENAS um JSON com os 3 campos adaptados:
{ "title": "...", "description": "...", "bullets": ["..."] }
`
}
