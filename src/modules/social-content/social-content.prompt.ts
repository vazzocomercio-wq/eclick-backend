import type { SocialChannel } from './social-content.types'

/** Onda 3 / S1 — prompt builder pra Social Content Generator.
 *
 * Recebe produto enriquecido (Onda 1) + canais escolhidos + estilo opcional
 * e devolve string de userPrompt pra Sonnet 4.6. Saída esperada: JSON
 * `{ channels: { <channel>: <shape do canal> } }`.
 */

interface ProductSummary {
  name:               string
  brand?:             string | null
  category?:          string | null
  price?:             number | null
  short_description?: string | null
  description?:       string | null
  differentials?:     string[] | null
  bullets?:           string[] | null
  target_audience?:   string | null
  tags?:              string[] | null
  ai_analysis?:       Record<string, unknown> | null
}

const SYSTEM_PROMPT = `Você é um social media manager especialista em e-commerce brasileiro.
Sua função: receber dados de um produto + lista de canais sociais e retornar
JSON com conteúdo otimizado por canal.

REGRAS GLOBAIS:
- Português brasileiro, tom direto e engajante
- Foco em conversão sem soar comercial demais
- Emojis com moderação (1-3 por bloco quando fizerem sentido)
- Hashtags relevantes ao produto + categoria + nicho (não inventar)
- Considerar sazonalidade da data atual (use data corrente do prompt)
- NUNCA inventar atributos que não estão nos dados do produto
- Saída deve ser JSON válido, sem markdown wrapper, sem comentários

NUNCA inclua dados sensíveis (CPF, telefone, email) em copies públicas.`

export function buildSocialContentPrompt(
  product: ProductSummary,
  channels: SocialChannel[],
  style?: string,
): { systemPrompt: string; userPrompt: string } {
  const today = new Date().toLocaleDateString('pt-BR')

  const userPrompt = `## DATA ATUAL
${today}

## PRODUTO
Nome: ${product.name}
Marca: ${product.brand || 'Não informada'}
Categoria: ${product.category || 'Geral'}
Preço: ${product.price != null ? `R$ ${Number(product.price).toFixed(2)}` : 'Sob consulta'}
Descrição: ${(product.short_description || product.description || '').substring(0, 600)}
Diferenciais: ${(product.differentials ?? []).join(', ') || '-'}
Bullets: ${(product.bullets ?? []).join(' | ') || '-'}
Público-alvo: ${product.target_audience || 'Geral'}
Tags: ${(product.tags ?? []).join(', ') || '-'}
${product.ai_analysis && Object.keys(product.ai_analysis).length > 0
  ? `\n## ANÁLISE VISUAL\n${JSON.stringify(product.ai_analysis).slice(0, 800)}`
  : ''}

## CANAIS SOLICITADOS
${channels.join(', ')}

## ESTILO
${style || 'Engajante, direto, com personalidade. Foco em conversão.'}

## REGRAS POR CANAL

### instagram_post / facebook_post
{ "caption": string (150-300 palavras, primeira linha = hook),
  "hashtags": string[] (15-20 mix volume alto + nicho),
  "image_suggestion": string (descrição da imagem ideal),
  "alt_text": string (acessibilidade),
  "cta": string ("Compre pelo link na bio" ou similar) }

### instagram_carousel
{ "slides": [{ "caption": string, "image_suggestion": string }] (5-7 slides),
  "main_caption": string,
  "hashtags": string[] }

### instagram_reels / tiktok_video
{ "script": string,
  "scenes": [{ "time": "0-3s", "action": string, "text_overlay": string }] (15-30s total),
  "audio_suggestion": string,
  "hashtags": string[] (5-8 reels, 3-5 tiktok),
  "caption": string }

### instagram_stories
{ "stories": [{ "type": "image|poll|quiz|slider", "text": string }] (3-5),
  "cta": string }

### facebook_ads
{ "headlines": string[] (3, max 40 chars cada),
  "descriptions": string[] (2, max 125 chars),
  "primary_text": string (125-250 chars, hook nas 2 primeiras linhas),
  "cta_type": "SHOP_NOW"|"LEARN_MORE"|"SIGN_UP",
  "target_audience_suggestion": string,
  "budget_suggestion_daily_brl": number }

### google_ads
{ "headlines": string[] (3, max 30 chars cada),
  "descriptions": string[] (2, max 90 chars),
  "primary_text": string,
  "cta_type": "SHOP_NOW",
  "keywords": string[] (10-15 intenção comercial),
  "negative_keywords": string[] (5-10),
  "budget_suggestion_daily_brl": number }

### whatsapp_broadcast
{ "message": string (max 500 chars, direto),
  "include_image": boolean,
  "include_link": boolean,
  "target_segment": "todos"|"compradores"|"interessados"|"inativos" }

### email_marketing
{ "subject": string (max 50 chars),
  "preview_text": string,
  "body_html": string (200-400 palavras, HTML simples),
  "cta_text": string,
  "cta_url": string }

## SAÍDA
Retorne APENAS JSON válido (sem \`\`\`):
{
  "channels": {
    ${channels.map(c => `"${c}": { ... }`).join(',\n    ')}
  }
}
Gere conteúdo para TODOS os canais solicitados.`

  return { systemPrompt: SYSTEM_PROMPT, userPrompt }
}

/** Prompt pra regeneração de 1 canal específico com instrução adicional. */
export function buildRegeneratePrompt(
  product: ProductSummary,
  channel: SocialChannel,
  previousContent: Record<string, unknown>,
  instruction: string,
): { systemPrompt: string; userPrompt: string } {
  const today = new Date().toLocaleDateString('pt-BR')

  const userPrompt = `## DATA ATUAL
${today}

## PRODUTO
Nome: ${product.name}
Marca: ${product.brand || '-'}
Preço: ${product.price != null ? `R$ ${Number(product.price).toFixed(2)}` : '-'}
Categoria: ${product.category || '-'}
Diferenciais: ${(product.differentials ?? []).join(', ') || '-'}

## CANAL
${channel}

## CONTEÚDO ATUAL (a refazer)
${JSON.stringify(previousContent, null, 2).slice(0, 1500)}

## INSTRUÇÃO DE REGERAÇÃO
${instruction}

## SAÍDA
Retorne APENAS JSON válido com a mesma estrutura do canal "${channel}", aplicando a instrução.`

  return { systemPrompt: SYSTEM_PROMPT, userPrompt }
}
