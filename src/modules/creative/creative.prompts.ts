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
// 3. Variante por marketplace (re-aproveita o anúncio base)
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
