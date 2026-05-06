import type { AdsPlatform, AdsObjective } from './ads-campaigns.types'

interface ProductSummary {
  name:               string
  brand?:             string | null
  category?:          string | null
  price?:             number | null
  short_description?: string | null
  description?:       string | null
  differentials?:     string[] | null
  target_audience?:   string | null
  ai_score?:          number | null
}

const SYSTEM_PROMPT = `Você é um gestor de tráfego pago especialista em e-commerce brasileiro
(Meta Ads, Google Ads, TikTok Ads, Mercado Livre Ads).

REGRAS GLOBAIS:
- Português brasileiro, copy direto e impactante
- Considerar sazonalidade da data atual (use a data fornecida)
- Headlines curtas (respeitar limite de chars por plataforma)
- Primary text com hook nas 2 primeiras linhas (vai aparecer truncado)
- CTA claro e direto
- Sugerir orçamento realista pra produto brasileiro (R$ 20-100/dia comum)
- Gerar 2-3 variantes de copy (A/B test)
- Sugerir público-alvo detalhado pra plataforma
- Gerar UTMs completos pra rastreamento
- NUNCA inventar atributos do produto que não foram informados
- Saída deve ser JSON válido sem markdown wrapper`

export function buildAdsCampaignPrompt(
  product: ProductSummary,
  platform: AdsPlatform,
  objective: AdsObjective,
): { systemPrompt: string; userPrompt: string } {
  const today = new Date().toLocaleDateString('pt-BR')

  const platformRules = PLATFORM_RULES[platform] ?? ''

  const userPrompt = `## DATA ATUAL
${today}

## PRODUTO
Nome: ${product.name}
Marca: ${product.brand ?? '-'}
Categoria: ${product.category ?? '-'}
Preço: ${product.price != null ? `R$ ${Number(product.price).toFixed(2)}` : '-'}
Descrição: ${(product.short_description ?? product.description ?? '').substring(0, 500)}
Diferenciais: ${(product.differentials ?? []).join(', ') || '-'}
Público: ${product.target_audience ?? 'Geral'}
${product.ai_score != null ? `Score do catálogo: ${product.ai_score}/100` : ''}

## PLATAFORMA: ${platform.toUpperCase()}
## OBJETIVO: ${objective}

${platformRules}

## SAÍDA — APENAS JSON VÁLIDO

{
  "campaign_name": "produto-plataforma-MMM-YY (ex: org-gaveta-meta-mai26)",
  "targeting": { /* segmentação completa pra ${platform} */ },
  "budget_suggestion": {
    "daily_brl": number,
    "total_brl": number,
    "duration_days": number,
    "bid_strategy": "lowest_cost"|"cost_cap"|"target_roas",
    "rationale": "texto curto explicando porquê desse orçamento"
  },
  "ad_copies": [
    {
      "variant": "A",
      "headline": "...",
      "primary_text": "...",
      "description": "...",
      "cta": "SHOP_NOW",
      "angle": "benefício principal explorado"
    },
    {
      "variant": "B",
      "headline": "...",
      "primary_text": "...",
      "description": "...",
      "cta": "SHOP_NOW",
      "angle": "ângulo diferente da variante A"
    }
  ],
  "utm_params": {
    "utm_source": "...",
    "utm_medium": "paid",
    "utm_campaign": "...",
    "utm_content": "varA"
  },
  "destination_url_suggestion": "string ou null",
  "estimated_results": {
    "impressions_daily": number,
    "clicks_daily": number,
    "estimated_cpc_brl": number,
    "estimated_conversions_daily": number,
    "estimated_roas": number
  }
}`

  return { systemPrompt: SYSTEM_PROMPT, userPrompt }
}

const PLATFORM_RULES: Partial<Record<AdsPlatform, string>> = {
  meta: `## REGRAS META ADS
- Headline: max 40 chars
- Primary text: 125-250 chars (primeiras 2 linhas visíveis)
- Description: max 125 chars
- CTAs válidos: SHOP_NOW, LEARN_MORE, SIGN_UP, CONTACT_US
- targeting deve incluir: age_min, age_max, genders, geo_locations
  (countries=["BR"], regions ou cities), interests (com id+name dos
  interest catalog do Meta), behaviors, custom_audiences (vazio se
  não tiver), lookalike_source (null)
`,
  google: `## REGRAS GOOGLE ADS
- Headline: max 30 chars (gerar 5+ no array)
- Description: max 90 chars (gerar 3+)
- Keywords: 10-15 de intenção comercial (comprar X, preço Y)
- Negative keywords: 5-10 (DIY, como fazer, grátis, download)
- CTAs válidos: SHOP_NOW
- targeting deve incluir: keywords[], negative_keywords[],
  locations (["BR"]), language ("pt"),
  device_targeting (["mobile","desktop"])
- Sugerir tipo de campanha: Search | Shopping | Performance Max
`,
  tiktok: `## REGRAS TIKTOK ADS
- Headline (texto principal): max 100 chars
- Hook obrigatório nos primeiros 3 segundos do criativo
- targeting: age_min, age_max, locations (["BR"]),
  interest_categories[], behaviors[]
- CTAs: SHOP_NOW, LEARN_MORE, DOWNLOAD_NOW
`,
  mercado_livre_ads: `## REGRAS MERCADO LIVRE ADS
- Use Product Ads (boost de anúncios já listados)
- Sugerir CPC max + budget diário
- Categorias-alvo do ML
- targeting: category_ids[], price_range_brl, budget
`,
}

/** Prompt pra regenerar SOMENTE os copies de uma campanha (sem mexer em
 *  targeting/budget). Mantém variant labels (A/B/C). */
export function buildRegenerateCopiesPrompt(
  product: ProductSummary,
  platform: AdsPlatform,
  previousCopies: Array<{ variant: string; headline: string; primary_text: string }>,
  instruction: string,
): { systemPrompt: string; userPrompt: string } {
  const userPrompt = `## PRODUTO
${product.name}${product.brand ? ` (${product.brand})` : ''}
${product.price != null ? `R$ ${Number(product.price).toFixed(2)}` : ''}

## PLATAFORMA
${platform.toUpperCase()}

## COPIES ATUAIS (${previousCopies.length})
${previousCopies.map(c => `${c.variant}: ${c.headline}\n   ${c.primary_text}`).join('\n\n')}

## INSTRUÇÃO
${instruction}

## SAÍDA
JSON válido, sem markdown:
{
  "ad_copies": [
    { "variant": "A", "headline": "...", "primary_text": "...", "description": "...", "cta": "...", "angle": "..." },
    ...
  ]
}
Mantenha mesmas variants (A/B/C) e respeite limites de chars da plataforma.`

  return { systemPrompt: SYSTEM_PROMPT, userPrompt }
}
