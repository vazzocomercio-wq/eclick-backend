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
} as const

export type FeatureKey = keyof typeof FEATURE_REGISTRY

export type Provider = 'anthropic' | 'openai'

export const FEATURE_KEYS = Object.keys(FEATURE_REGISTRY) as FeatureKey[]
