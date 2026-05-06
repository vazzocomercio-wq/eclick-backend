/** Registry of AI features in the platform. Each feature has primary +
 * optional fallback configuration. UI lists these features so users can
 * override per-org via ai_feature_settings.
 *
 * To add a new feature: add an entry below, then call
 * llm.generateText({ feature: 'your_key', ... }) from the consumer.
 *
 * Model IDs are aligned with the canonical catalog at
 * src/constants/ai-models.ts. Pricing for each ID lives in llm.service.ts
 * PRICING table — keep the two in sync. */
export const FEATURE_REGISTRY = {
  campaign_copy: {
    label:       'Copy de campanhas',
    description: 'Gera mensagens persuasivas para campanhas',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'openai',    model: 'gpt-5-mini' },
  },
  product_title: {
    label:       'Títulos de produto',
    description: 'Gera títulos otimizados para marketplace',
    primary:     { provider: 'openai',    model: 'gpt-5-nano' },
    fallback:    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  },
  embeddings: {
    label:       'Embeddings (busca semântica)',
    description: 'Vetoriza conteúdo para busca por significado',
    primary:     { provider: 'openai',    model: 'text-embedding-3-small' },
    fallback:    null,
  },
  atendente_response: {
    label:       'Atendente IA',
    description: 'Gera respostas em conversas',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'openai',    model: 'gpt-5-mini' },
  },
  // F5-2: imagens de capa de campanhas via gpt-image-1.
  // Flux fica como override opcional (não tem callFluxImage ainda).
  campaign_card: {
    label:       'Capas de campanhas',
    description: 'Gera cards promocionais para WhatsApp/Instagram',
    primary:     { provider: 'openai', model: 'gpt-image-1' },
    fallback:    null,
  },
  // Sprint ML Questions AI — sugere resposta pra pergunta do ML usando
  // contexto do anúncio + histórico P&R. Sonnet pra qualidade.
  ml_question_suggest: {
    label:       'Sugestão de resposta (ML)',
    description: 'Gera resposta sugerida para perguntas do Mercado Livre',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'openai',    model: 'gpt-5-mini' },
  },
  // Transformações rápidas (encurtar/humanizar/garantia/pronta) sobre
  // texto que o user já está editando. Haiku pra latência baixa.
  ml_question_transform: {
    label:       'Transformar resposta (ML)',
    description: 'Transforma texto de resposta (encurtar/humanizar/etc)',
    primary:     { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    fallback:    { provider: 'openai',    model: 'gpt-5-nano' },
  },
  // Flag-only — não usa generateText. ai_feature_settings.enabled
  // controla se o cron envia respostas automaticamente quando
  // confidence >= 0.70. primary/fallback são placeholders exigidos
  // pelo schema mas não invocados.
  ml_question_auto_send: {
    label:       'Auto-resposta de perguntas (ML)',
    description: 'Envia automaticamente sugestões com confiança >= 0.70',
    primary:     { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    fallback:    null,
  },
  // Sprint F6 IA Criativo — Vision + listing generation
  creative_vision: {
    label:       'Análise visual de produto (Creative)',
    description: 'Vision: detecta tipo, cor, material e riscos visuais do produto',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    null, // OpenAI vision pode ser adicionado depois
  },
  creative_listing: {
    label:       'Anúncio de marketplace (Creative)',
    description: 'Gera título + descrição + bullets + ficha técnica + SEO',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'openai',    model: 'gpt-5-mini' },
  },
  // E2: pipeline de imagens
  creative_image_prompts: {
    label:       'Prompts de imagem (Creative)',
    description: 'Sonnet gera N prompts de imagem coerentes em 1 chamada',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    null,
  },
  creative_image: {
    label:       'Geração de imagem (Creative)',
    description: 'gpt-image-1 com sourceImageUrl da imagem do produto',
    primary:     { provider: 'openai', model: 'gpt-image-1' },
    fallback:    null,
  },
  // E3a: pipeline de vídeos
  creative_video_prompts: {
    label:       'Prompts de vídeo (Creative)',
    description: 'Sonnet gera N prompts de cinemagraph/motion em 1 chamada',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    null,
  },
  // Copiloto flutuante (V1) — Haiku pra latência baixa + custo mínimo
  copilot_help: {
    label:       'Copiloto flutuante',
    description: 'Responde dúvidas em tempo real sobre tela atual. Haiku pra ser snappy.',
    primary:     { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    fallback:    { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  },
  // Onda 1 M2: enriquecimento de catálogo
  catalog_enrichment: {
    label:       'Enriquecimento AI do catálogo',
    description: 'Sonnet lê produto + foto e gera short/long description, keywords, target audience, use cases, pros/cons, SEO',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    null,
  },
  // Onda 3 S1: Social Content Generator — gera posts/reels/ads copy
  // por canal a partir de produto enriquecido. Sonnet: precisa de criatividade
  // + estrutura JSON estrita (jsonMode). Fallback OpenAI mini pra resiliência.
  social_content_gen: {
    label:       'Conteúdo social (S1)',
    description: 'Gera caption/script/ad copy por canal (IG, TikTok, Meta Ads, Google Ads, etc.) a partir do produto',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'openai',    model: 'gpt-5-mini' },
  },
  // Onda 3 S4: Ads Hub — gera campanha completa (público + copies + budget + UTMs)
  // Sonnet pra qualidade do strategist + jsonMode pra estrutura
  ads_campaign_gen: {
    label:       'Campanhas Ads (S4)',
    description: 'Gera campanha Meta/Google/TikTok com targeting + copies A/B + budget + UTMs',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'openai',    model: 'gpt-5-mini' },
  },
  // Onda 4 A1: Pricing AI — sugere preço ótimo com 3 cenários
  // Sonnet pra raciocínio analítico (margem + concorrência + estoque + vendas)
  pricing_ai_suggest: {
    label:       'Sugestão de preço (A1)',
    description: 'Analisa fatores e sugere preço ótimo com cenários conservador/ótimo/agressivo',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'openai',    model: 'gpt-5-mini' },
  },
  // Onda 4 A5: Kits & Combos — IA sugere kits comerciais a partir do catálogo
  kits_generate: {
    label:       'Geração de kits (A5)',
    description: 'IA combina produtos do catálogo em kits/combos com naming + pricing + reasoning',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'openai',    model: 'gpt-5-mini' },
  },
} as const

export type FeatureKey = keyof typeof FEATURE_REGISTRY

export type Provider = 'anthropic' | 'openai'

export const FEATURE_KEYS = Object.keys(FEATURE_REGISTRY) as FeatureKey[]
