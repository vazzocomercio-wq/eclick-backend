/** Regras específicas por marketplace pra geração de anúncio textual.
 *  Usadas como contexto no prompt do LLM e injetadas em
 *  creative_briefings.marketplace_rules quando o briefing é criado. */

export type Marketplace =
  | 'mercado_livre'
  | 'shopee'
  | 'amazon'
  | 'magalu'
  | 'loja_propria'
  | 'multi'

export interface MarketplaceRules {
  max_title_chars:        number
  max_description_chars:  number
  max_images:             number
  required_white_bg_main: boolean
  ficha_tecnica_required: boolean
  bullet_style:           'emoji_prefix' | 'dash_prefix' | 'plain'
  title_rules:            string
}

export const MARKETPLACE_RULES: Record<Marketplace, MarketplaceRules> = {
  mercado_livre: {
    max_title_chars:        60,
    max_description_chars:  50_000,
    max_images:             10,
    required_white_bg_main: false,
    ficha_tecnica_required: true,
    bullet_style:           'emoji_prefix',
    title_rules: [
      '- Não usar CAPS LOCK no título inteiro',
      '- Formato: [Produto] [Característica Principal] [Marca] [Modelo]',
      '- Não usar palavras proibidas: "promoção", "oferta", "desconto", "frete grátis"',
      '- Não usar pontuação excessiva',
    ].join('\n'),
  },
  shopee: {
    max_title_chars:        120,
    max_description_chars:  10_000,
    max_images:             9,
    required_white_bg_main: true,
    ficha_tecnica_required: false,
    bullet_style:           'dash_prefix',
    title_rules: [
      '- Formato: [Marca] [Produto] [Especificação] [Quantidade]',
      '- Hashtags no final quando relevante',
      '- Mais descritivo que ML',
    ].join('\n'),
  },
  amazon: {
    max_title_chars:        200,
    max_description_chars:  2_000,
    max_images:             9,
    required_white_bg_main: true,
    ficha_tecnica_required: true,
    bullet_style:           'plain',
    title_rules: [
      '- Formato: [Marca] - [Produto] - [Características] - [Quantidade/Tamanho]',
      '- Capitalizar primeira letra de cada palavra',
      '- Não usar símbolos especiais no título',
    ].join('\n'),
  },
  magalu: {
    max_title_chars:        150,
    max_description_chars:  30_000,
    max_images:             10,
    required_white_bg_main: false,
    ficha_tecnica_required: true,
    bullet_style:           'emoji_prefix',
    title_rules: [
      '- Similar ao ML mas aceita títulos mais longos',
      '- Formato: [Produto] [Marca] [Modelo] [Cor] [Características]',
    ].join('\n'),
  },
  loja_propria: {
    max_title_chars:        150,
    max_description_chars:  30_000,
    max_images:             10,
    required_white_bg_main: false,
    ficha_tecnica_required: false,
    bullet_style:           'emoji_prefix',
    title_rules: [
      '- Sem restrições rígidas — priorize SEO e clareza',
      '- Inclua marca + modelo + benefício principal',
    ].join('\n'),
  },
  multi: {
    max_title_chars:        60, // Conservador — pega o menor (ML)
    max_description_chars:  2_000, // Conservador — pega o menor (Amazon)
    max_images:             9,
    required_white_bg_main: true,
    ficha_tecnica_required: true,
    bullet_style:           'emoji_prefix',
    title_rules: [
      '- Conservador: respeita as regras mais restritivas (ML para título, Amazon para descrição)',
      '- Use o menor limite de cada plataforma pra garantir compatibilidade cruzada',
    ].join('\n'),
  },
}

export function getMarketplaceRules(target: Marketplace): MarketplaceRules {
  return MARKETPLACE_RULES[target] ?? MARKETPLACE_RULES.multi
}
