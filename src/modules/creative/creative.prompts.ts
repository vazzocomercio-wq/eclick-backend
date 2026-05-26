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
  /** e-Otimizer IA: research da categoria ML pra alimentar LLM com padrões reais. */
  ml_research?: {
    category_ml_id:   string
    category_name:    string
    top_keywords:     Array<{
      keyword:    string
      frequency:  number
      sources_mlb: string[]
      recommend:  'use' | 'use_if_true' | 'avoid'
    }>
    title_pattern: {
      avg_length:      number
      median_length:   number
      top_first_words: Array<{ word: string; count: number }>
      examples:        string[]
    }
    attributes_stats: Array<{
      attribute_id:   string
      attribute_name: string
      fill_rate:      number
      top_values:     Array<{ value: string; count: number }>
      is_required:    boolean
    }>
    competitors_top5: Array<{
      title:           string
      price:           number
      sold_quantity:   number
      power_seller:    string | null
      catalog_listing: boolean
    }>
    price_stats: {
      median: number; avg: number; p25: number; p75: number
    }
  }
}

/**
 * e-Otimizer IA — regras duras pra IA não inventar dados.
 * Exportadas e referenciadas no prompt sempre que ml_research é passado.
 */
export const HARD_RULES_FORBIDDEN = [
  'inventar potência, voltagem, watts, dimensões não informadas no produto',
  'inventar cor, material, marca ou modelo que não constam',
  'usar keyword de produto diferente (ex: "cromado" pra produto "dourado")',
  'mudar a categoria implícita do produto',
  'prometer recurso inexistente (resistente à água, antiqueda, etc) sem evidência',
  'copiar título exato de concorrente — sempre adaptar',
  'usar superlativos falsos ("melhor do mundo", "único", "número 1")',
  'prometer prazos, garantias ou condições não informadas',
] as const

/**
 * Levers de GEO (Generative Engine Optimization) comprovados pela literatura
 * (ver memória [[geo-papers]]: Aggarwal KDD'24 + E-GEO 2025). Mesmos princípios
 * do geo-optimizer (description-builder/title-rewriter): o que faz ChatGPT/
 * Perplexity/Gemini CITAREM e recomendarem o produto. NÃO altera o formato JSON
 * nem o caminho de atributos/publicação do ML.
 */
export const GEO_DIRECTIVES = `## COMO ESCREVER PRA SER CITADO POR IA (GEO — baseado em evidência)
Motores de IA (ChatGPT, Perplexity, Gemini) recomendam produtos pelo conteúdo. Aplique:
- DESCRIÇÃO data-dense, nesta lógica: (1) resumo em 2 linhas com o benefício e a INTENÇÃO de uso; (2) especificações com NÚMEROS/medidas concretas (dado quantitativo pesa mais que adjetivo); (3) para quem serve e para quem NÃO serve; (4) diferenciais vs alternativas da categoria (factual, sem citar concorrente por nome); (5) evidência (avaliações/certificações) SOMENTE se informada. Fluente e escaneável.
- TÍTULO: comece pelo termo que o comprador buscaria + 1 diferencial concreto; soe natural (como a pessoa pede a uma IA). Respeite o limite de caracteres do marketplace.
- FAQ: perguntas REAIS de compra/uso/compatibilidade, respondidas só com os fatos disponíveis (se faltar um dado, oriente honestamente — nunca invente).
- NÃO repita a mesma palavra-chave pra "encher" (keyword stuffing NÃO funciona em IA) — use vocabulário variado e sinônimos naturais.`

export function buildListingPrompt(input: ListingPromptInput): string {
  const rules = getMarketplaceRules(input.briefing.target_marketplace)
  const p = input.product
  const r = input.ml_research

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
${r ? buildResearchSection(r) : ''}
## REGRAS DO MARKETPLACE
${rules.title_rules}
- Título: máximo ${rules.max_title_chars} caracteres${r ? ` (média da categoria: ${r.title_pattern.avg_length})` : ''}
- Descrição: entre 500 e ${Math.min(rules.max_description_chars, 2000)} caracteres
- Bullets: entre 5 e 7
- Estilo de bullet: ${describeBulletStyle(rules.bullet_style)}
- Ficha técnica: ${rules.ficha_tecnica_required ? 'OBRIGATÓRIA — mínimo 7 campos' : 'opcional, recomendada'}
- Palavras-chave: 10 a 15, relevantes para busca no marketplace
- FAQ: 5 perguntas reais que compradores fariam

## REGRAS DURAS (NÃO NEGOCIÁVEIS)
${HARD_RULES_FORBIDDEN.map((rule, i) => `${i + 1}. NUNCA ${rule}`).join('\n')}
${r ? `
## DIRETRIZ DE USO DAS KEYWORDS DO MERCADO
- Keywords marcadas "use" (>50% dos top): USE no título E na descrição quando o produto realmente tem essa característica
- Keywords marcadas "use_if_true": só use SE o produto tem essa característica de verdade (ex: "LED" só se for LED)
- Keywords marcadas "avoid": ignore — são ruído da cauda
` : ''}
${GEO_DIRECTIVES}
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

/**
 * Constrói a seção "## ANÁLISE DE MERCADO ML — DADOS REAIS" do prompt.
 * Inclui top 5 títulos, keywords com sources, padrão de título e
 * atributos obrigatórios — pra LLM gerar baseado em padrões empíricos
 * em vez de "imaginar" boas práticas de SEO.
 */
function buildResearchSection(r: NonNullable<ListingPromptInput['ml_research']>): string {
  const topKw = r.top_keywords.slice(0, 15)
  const attrsRequired = r.attributes_stats.filter(a => a.is_required).slice(0, 10)
  const attrsTopFilled = r.attributes_stats
    .filter(a => !a.is_required && a.fill_rate >= 0.5)
    .slice(0, 10)

  return `
## ANÁLISE DE MERCADO ML — DADOS REAIS DA CATEGORIA "${r.category_name}"

### Top 5 anúncios concorrentes (analisados):
${r.competitors_top5.map((c, i) =>
  `${i + 1}. "${c.title}" — R$ ${c.price.toFixed(2)} · ${c.sold_quantity} vendas${c.power_seller ? ` · ${c.power_seller}` : ''}${c.catalog_listing ? ' · catálogo' : ''}`
).join('\n')}

### Padrão de título da categoria:
- Tamanho médio: ${r.title_pattern.avg_length} chars (mediana: ${r.title_pattern.median_length})
- Primeiras palavras mais comuns: ${r.title_pattern.top_first_words.map(w => `"${w.word}" (${w.count}x)`).join(', ')}

### Keywords que aparecem nos top 20 (com frequência):
${topKw.map(kw =>
  `- "${kw.keyword}" — ${kw.frequency} dos top 20 → ${kw.recommend.toUpperCase()}`
).join('\n')}

### Preço de mercado (R$):
- Mediana: ${r.price_stats.median.toFixed(2)}
- Faixa P25-P75: ${r.price_stats.p25.toFixed(2)} a ${r.price_stats.p75.toFixed(2)}
${attrsRequired.length > 0 ? `
### Atributos OBRIGATÓRIOS da categoria (ML exige):
${attrsRequired.map(a => `- ${a.attribute_name} (${a.attribute_id}) — preencher na technical_sheet${a.top_values.length > 0 ? `; top valores: ${a.top_values.slice(0, 3).map(v => `"${v.value}"`).join(', ')}` : ''}`).join('\n')}` : ''}
${attrsTopFilled.length > 0 ? `
### Atributos RECOMENDADOS (preenchidos em ≥50% dos top, ajudam SEO):
${attrsTopFilled.map(a => `- ${a.attribute_name} — ${Math.round(a.fill_rate * 100)}% dos top preenchem${a.top_values.length > 0 ? `; ex: ${a.top_values.slice(0, 3).map(v => `"${v.value}"`).join(', ')}` : ''}`).join('\n')}` : ''}
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
    environments:       string[]
    custom_environment: string | null
    custom_prompt:      string | null
    background_color:   string
    use_logo:           boolean
    communication_tone: string
    image_count:        number
  }
  count: number
}

/** Distribui N posições entre M ambientes em round-robin. Retorna array de
 *  strings (1 ambiente por posição). Vazio → ['neutral'] de fallback. */
function distributeEnvironments(envs: string[], customEnv: string | null, count: number): string[] {
  const resolved = envs.length === 0
    ? ['neutral']
    : envs.map(e => e === 'custom' ? (customEnv ?? 'neutral') : e)
  return Array.from({ length: count }, (_, i) => resolved[i % resolved.length])
}

/**
 * Pede pro Sonnet gerar N prompts em 1 chamada — preserva contexto entre as
 * posições (hero → lifestyle → close-up → in-use → packaging → infographic
 * → scale → multi-angle → top-down → 3/4 view, ajustado por count).
 * Distribui as N posições entre os M ambientes selecionados (round-robin).
 * Retorna array de strings em inglês (gpt-image-1 funciona melhor em EN).
 */
export function buildImagePromptsRequest(input: ImagePromptsBuilderInput): string {
  const p = input.product
  const b = input.briefing
  const envByPosition = distributeEnvironments(b.environments, b.custom_environment, input.count)
  const envSummary = b.environments.length === 0
    ? 'neutral (default)'
    : b.environments.map(e => e === 'custom' ? (b.custom_environment ?? 'neutral') : e).join(', ')

  const positionList = envByPosition
    .map((e, i) => `${i + 1}. environment="${e}"`)
    .join('\n')

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
Environments:    ${envSummary}
Background:      ${b.background_color}
Logo allowed:    ${b.use_logo ? 'yes — a SECOND reference image (the brand logo) is provided alongside the product. Apply the logo discreetly (small, corner placement, ~8% of frame) without distorting it.' : 'no — strictly no text/logos/watermarks'}
Tone:            ${b.communication_tone}
${b.custom_prompt ? `\n## ADDITIONAL USER INSTRUCTION\n${b.custom_prompt.slice(0, 1500)}\n` : ''}
## ENVIRONMENT ASSIGNMENT (1 environment per position)
${positionList}

## VARIATION STRATEGY (cycle through, adjust to count=${input.count})
1. Hero shot — clean, centered, marketplace-cover quality
2. Lifestyle — product in real-world use, in the assigned environment
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
- ALWAYS reference the product positively (e.g., "the product shown in the first reference image")
- Match each position to its assigned environment from the list above
- Specify lighting (e.g., "soft natural daylight", "studio softbox")
- Specify camera angle (e.g., "eye-level", "45-degree top-down", "macro 50mm")
- Match the visual_style strictly (premium ≠ promocional)
- Background color guideline: ${b.background_color}${b.use_logo ? '\n- The second reference image is the brand logo — place it discreetly without distorting it' : '\n- DO NOT add text, watermarks, logos, or branding overlays'}
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
  const envSummary = b.environments.length === 0
    ? 'neutral (default)'
    : b.environments.map(e => e === 'custom' ? (b.custom_environment ?? 'neutral') : e).join(', ')

  const colorVal = p.color ?? (p.ai_analysis?.detected_color as string | undefined) ?? ''
  const materialVal = p.material ?? (p.ai_analysis?.detected_material as string | undefined) ?? ''
  const productDescriptors = [colorVal, materialVal].filter(Boolean).join(' ')
  const targetSubject = productDescriptors ? `the ${productDescriptors} ${p.category}` : `the ${p.category}`

  return `You are a senior motion-graphics director crafting short product videos for marketplace listings.

The product image will be passed as the FIRST FRAME (image2video). Your prompts describe what HAPPENS during the ${input.durationSec}-second clip — camera motion, ambient lighting changes, micro-actions.

## 🚨 ABSOLUTE RULES — NEVER NEGOTIABLE, NO EXCEPTIONS

These rules override every other instruction in this prompt. If any creative idea
conflicts with these rules, DROP THE IDEA. There are zero acceptable exceptions.

1. **NEVER alter the product's SHAPE, FORMAT, GEOMETRY, or SILHOUETTE.**
   The product in the final frame must be visually identical to the source frame.
   No morphing, no elongating, no widening, no extra elements growing out of it,
   no parts disappearing, no surface details changing.

2. **NEVER alter the product's COLOR, MATERIAL, or FINISH.**
   A brushed gold lamp stays brushed gold. A white surface stays white. Same
   reflectivity, same texture, same tone, frame 1 to frame N.

3. **NEVER add effects that are not part of the product's REAL physical function.**
   If the product is a lamp that emits warm 3000K light, the video shows warm
   3000K light — not pulsing colors, not prismatic rainbows, not glowing auras,
   not light beams shooting outward, not magical sparkles. Whatever the product
   does NOT do in real life, it MUST NOT do in this video.

4. **The customer who watches this video will receive the EXACT product shown.**
   Anything you depict that the physical product can't replicate becomes false
   advertising. When in doubt, choose the duller, more honest motion.

These three rules apply to EVERY prompt you generate, EVERY frame, EVERY variation.

---

## TARGET PRODUCT — CAMERA FOCUS LOCK
Name:            ${p.name}
Subject:         ${targetSubject}, centered in the source frame.

⚠️ The camera MUST keep "${p.name}" as the SOLE focal subject for the entire clip.
The source frame may contain OTHER items (furniture, lamps, appliances, decor,
plants, fixtures, secondary products). These are CONTEXT ONLY — never let the
camera pan toward them, zoom into them, focus on them, or treat them as the hero.
Every camera move, lighting change, or micro-action must serve to showcase
"${p.name}" — not the surrounding scene.

## PRODUCT DETAILS
Category:        ${p.category}
Color:           ${colorVal || 'N/A'}
Material:        ${materialVal || 'N/A'}
Differentials:   ${(p.differentials ?? []).join(', ') || 'N/A'}

## AI VISUAL ANALYSIS
${JSON.stringify(p.ai_analysis ?? {}, null, 2)}

## BRIEFING
Visual style:    ${b.visual_style}
Environments:    ${envSummary}
Tone:            ${b.communication_tone}
Aspect ratio:    ${input.aspectRatio}
Duration:        ${input.durationSec}s
${b.custom_prompt ? `\n## ADDITIONAL USER INSTRUCTION\n${b.custom_prompt.slice(0, 1500)}\n` : ''}

## VARIATION STRATEGY (cycle through, ${input.count} total)
1. Cinemagraph hero — subtle motion (dust particles, light shift), ${targetSubject} centered, camera barely moves
2. Slow zoom-in detail — camera slowly approaches ${targetSubject}, reveals texture/finish OF IT (never of adjacent items)
3. Product rotation — turntable feel around ${targetSubject}, 360° if possible in ${input.durationSec}s
4. Hands present — hands gently enter frame, lift or rotate ${targetSubject} specifically
5. Action / use — context of use OF ${targetSubject} (cooking under the lamp, etc.) — but ${targetSubject} stays the visual hero

## RULES
- Each prompt: 1-3 sentences, English, optimized for image2video
- EVERY prompt must EXPLICITLY name "${p.name}" or "${targetSubject}" as the focus subject
- ALWAYS describe motion explicitly (camera move, lighting shift, action)
- Specify pace: "slow", "smooth", "gentle" — avoid frenetic motion
- Match visual_style strictly (premium = elegant slow motion; promocional = bolder energy)
- DO NOT add text, watermarks, logos, or branding overlays
- DO NOT change product shape, color, or appearance
- DO NOT pan to / zoom to / focus on any OTHER products or scene elements (other lamps,
  furniture, appliances, plants, fixtures). Even if visually appealing, they are background.

## FUNCTIONAL REALISM (mandatory — marketplace truth-in-advertising)
The video shows the product behaving as it ACTUALLY behaves in real life. Customers will
see this video and expect the real product to behave the same way. Anything you describe
that doesn't match physical reality becomes false advertising.

❌ NEVER describe these unless the product's CORE function explicitly produces them:
   - Prismatic refractions / rainbow light scatter (only for actual prisms or crystal balls used as prisms)
   - Sparkles, light pinpoints, glowing facets in unrealistic colors
   - Floating particles / bokeh drifting upward (only if physically justified — steam from cooking,
     smoke from incense, dust in a sunbeam shaft, etc.)
   - Light pulsing on its own / lamps brightening and dimming hypnotically (real lamps stay constant)
   - Anything magical, glowing auras, halos, light beams shooting outward
   - Color-shifting light when the product has a fixed temperature (3000K stays 3000K)
   - Mist, fog, atmospheric haze that wasn't part of the source image

✅ ALLOWED motion / effects:
   - Slow camera move (dolly, pan, tilt, orbit, push-in/out)
   - Natural lighting (golden hour shift, soft cloud passing, candle flicker if appropriate)
   - Subtle specular highlights that already exist sliding across surfaces from camera motion
   - Realistic micro-actions: hand entering frame, food steaming, fabric draping, drink pouring
   - Reflections / shadows shifting as the camera moves (geometry, not magic)
   - Dust motes in a sunbeam (only if scene has visible sunbeam)

Translation: pretend you're shooting B-roll with a real camera and a real product.
If a sober cinematographer wouldn't film it that way, don't write it.

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
