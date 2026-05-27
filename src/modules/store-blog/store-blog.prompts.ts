/**
 * Prompts do Blog da Loja — artigo GEO-otimizado CIENTE DOS PRODUTOS da loja.
 *
 * Princípio GEO: conteúdo que CITA FONTES, usa ESTATÍSTICAS, é CLARO e tem FAQ
 * é mais citado pelos motores de IA (ChatGPT/Gemini/Perplexity). Aqui o objetivo
 * extra é fazer os PRODUTOS DA LOJA serem descobertos/recomendados — o artigo
 * apresenta e linka produtos reais (bloco productGrid), de forma útil e honesta.
 */
import type { StoreProductLite } from './store-blog.types';

export const STORE_ARTICLE_SYSTEM_PROMPT = `Você é o redator de conteúdo da loja. Escreve em PT-BR, tom prestativo e honesto — ajuda o leitor a decidir, sem ser "vendedor chato". O artigo serve a DOIS objetivos:
1) Ser ÚTIL e GEO-otimizado pra ser CITADO pelos motores de IA (ChatGPT/Gemini/Perplexity) e rankear no Google — então CITE FONTES quando fizer afirmação forte, use dados/estatísticas quando fizer sentido, escreva claro (H2 + parágrafos curtos) e inclua FAQ.
2) Apresentar PRODUTOS REAIS da loja de forma natural (guia de compra, comparativo, "como escolher"), usando o bloco "productGrid" com os ids dos produtos fornecidos. Recomende com critério — nunca empurre o que não cabe no contexto.

NUNCA invente estatística, fonte, preço ou característica de produto. Use só os produtos da lista fornecida (pelos ids). Se não houver produto adequado pra um trecho, escreva qualitativo.

FORMATO: responda APENAS com JSON válido (sem markdown), neste schema:
{
  "title": string,                 // 40-70 chars, forte
  "slug": string,                  // kebab-case curto, sem acento
  "excerpt": string,               // 2-3 frases, 120-280 chars
  "tldr": string[],                // 3-5 bullets
  "sections": [
    { "heading": string,
      "paragraphs": string[],
      "blocks": [
        { "type": "productGrid", "productIds": string[] } |        // apresenta produtos reais (use os ids da lista)
        { "type": "stat", "value": string, "label": string, "source": string } |
        { "type": "callout", "variant": "info"|"tip"|"warning", "title": string, "body": string } |
        { "type": "comparison", "leftLabel": string, "rightLabel": string, "rows": [{ "aspect": string, "left": string, "right": string }] } |
        { "type": "image", "prompt": string, "alt": string, "caption": string }   // prompt em INGLÊS
      ]
    }
  ],
  "faq": [{ "question": string, "answer": string }],   // 3-6
  "aiPrompts": string[],           // 3-6 perguntas reais que o post responde
  "citationSources": [{ "title": string, "url": string, "authorOrOrg": string, "year": number }],
  "tags": string[],                // 2-5 kebab-case
  "featuredProductIds": string[],  // ids dos produtos apresentados no artigo
  "seoTitle": string,              // <= 65 chars
  "metaDescription": string,       // 120-160 chars
  "focusKeyword": string,
  "readingTimeMinutes": number,
  "coverImagePrompt": string       // prompt em INGLÊS pra capa
}

Inclua PELO MENOS 1 bloco "productGrid" com produtos reais quando a lista tiver produtos pertinentes. Corpo com ~700+ palavras.`;

export function buildStoreArticleUserPrompt(input: {
  topic: string;
  notes?: string;
  storeName?: string;
  voice?: string;
  storeUrl?: string;
  knowledge?: string;
  products: StoreProductLite[];
}): string {
  const productLines = input.products
    .slice(0, 40)
    .map(
      (p) =>
        `- id=${p.id} | ${p.name}${p.brand ? ` (${p.brand})` : ''}${p.category ? ` [${p.category}]` : ''} | R$ ${p.price?.toFixed?.(2) ?? p.price}${p.short_description ? ` — ${p.short_description.slice(0, 120)}` : ''}`,
    )
    .join('\n');
  return [
    input.voice ? `VOZ DA MARCA (siga o tom): ${input.voice}` : '',
    input.knowledge ? `BASE DE CONHECIMENTO (referência factual — não copie literal):\n${input.knowledge}` : '',
    input.storeName ? `LOJA: ${input.storeName}` : '',
    `TEMA/PAUTA: ${input.topic}`,
    input.notes ? `DIREÇÕES EXTRAS: ${input.notes}` : '',
    '',
    'PRODUTOS DISPONÍVEIS DA LOJA (use os ids no productGrid; só estes existem):',
    productLines || '(nenhum produto fornecido — escreva o artigo sem productGrid)',
    '',
    'COVER IMAGE PROMPT: descreva (em inglês) uma capa atraente e coerente com o tema e a estética da loja, sem texto, sem logos.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function fallbackCoverPrompt(title: string): string {
  return `Editorial blog cover image about "${title}", clean, modern, appealing, no text, no logos, high quality, 16:9.`;
}

export const STORE_IDEATE_SYSTEM_PROMPT = `Você é o estrategista de conteúdo da loja. Propõe PAUTAS de blog em PT-BR que (a) respondem dúvidas reais de quem está comprando, (b) têm potencial GEO (dá pra citar fontes/dados + FAQ) e (c) dão pra apresentar produtos reais da loja de forma natural (guia/comparativo/como escolher).

Responda APENAS JSON válido:
{ "topics": [ {
  "title": string,
  "angle": string,
  "why": string,
  "aiPrompts": [string],
  "productIds": [string]
} ] }`;

export function buildStoreIdeateUserPrompt(input: {
  seed?: string;
  count: number;
  storeName?: string;
  existingTitles?: string[];
  products: StoreProductLite[];
}): string {
  const productLines = input.products
    .slice(0, 50)
    .map((p) => `- id=${p.id} | ${p.name}${p.category ? ` [${p.category}]` : ''}`)
    .join('\n');
  return [
    input.storeName ? `LOJA: ${input.storeName}` : '',
    `Proponha ${input.count} pautas.`,
    input.seed ? `FOCO/SEMENTE: ${input.seed}` : 'Sem semente — proponha as mais valiosas pra atrair compradores.',
    '',
    'PRODUTOS DA LOJA (use ids reais em productIds):',
    productLines || '(catálogo vazio)',
    input.existingTitles?.length ? `\nJÁ COBERTO (não repita): ${input.existingTitles.slice(0, 40).join(' | ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
