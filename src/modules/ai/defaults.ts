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
} as const

export type FeatureKey = keyof typeof FEATURE_REGISTRY

export type Provider = 'anthropic' | 'openai'

export const FEATURE_KEYS = Object.keys(FEATURE_REGISTRY) as FeatureKey[]
