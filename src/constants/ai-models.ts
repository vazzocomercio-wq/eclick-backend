// Catálogo embutido de modelos de IA disponíveis no eClick.
// Costs are in USD per 1M tokens (Anthropic + OpenAI public pricing as of 2026-04).
// Update this file when models or prices change — UI reads from here via
// /ai/providers/available which filters by which providers are connected
// in api_credentials.

export type ModelTier = 'fast' | 'balanced' | 'powerful' | 'reasoning' | 'embedding'

export interface AiModel {
  id:                  string
  name:                string
  tier:                ModelTier
  cost_input_per_1m:   number
  cost_output_per_1m:  number
  description:         string
  supports_embedding:  boolean
  context_window?:     number
}

export interface AiProviderDef {
  id:        string                // matches api_credentials.provider
  name:      string                // human label
  models:    AiModel[]
}

export const AI_PROVIDERS: AiProviderDef[] = [
  {
    id:   'anthropic',
    name: 'Anthropic (Claude)',
    models: [
      {
        id:                 'claude-haiku-4-5-20251001',
        name:               'Claude Haiku 4.5',
        tier:               'fast',
        cost_input_per_1m:  0.25,
        cost_output_per_1m: 1.25,
        description:        'Mais rápido e barato. Bom pra classificação, respostas curtas, alta vazão.',
        supports_embedding: false,
        context_window:     200_000,
      },
      {
        id:                 'claude-sonnet-4-6',
        name:               'Claude Sonnet 4.6',
        tier:               'balanced',
        cost_input_per_1m:  3.00,
        cost_output_per_1m: 15.00,
        description:        'Equilíbrio entre qualidade e custo. Default da maioria dos agentes.',
        supports_embedding: false,
        context_window:     200_000,
      },
      {
        id:                 'claude-opus-4-7',
        name:               'Claude Opus 4.7',
        tier:               'powerful',
        cost_input_per_1m:  15.00,
        cost_output_per_1m: 75.00,
        description:        'Mais potente. Para reclamações complexas, raciocínio multi-passo.',
        supports_embedding: false,
        context_window:     1_000_000,
      },
    ],
  },
  {
    id:   'openai',
    name: 'OpenAI (ChatGPT)',
    models: [
      {
        id:                 'gpt-5-nano',
        name:               'GPT-5 Nano',
        tier:               'fast',
        cost_input_per_1m:  0.15,
        cost_output_per_1m: 0.60,
        description:        'Rápido e barato, equivalente ao Haiku.',
        supports_embedding: false,
        context_window:     128_000,
      },
      {
        id:                 'gpt-5-mini',
        name:               'GPT-5 Mini',
        tier:               'balanced',
        cost_input_per_1m:  0.30,
        cost_output_per_1m: 2.40,
        description:        'Custo-benefício pra workflows de produção.',
        supports_embedding: false,
        context_window:     128_000,
      },
      {
        id:                 'gpt-5',
        name:               'GPT-5',
        tier:               'powerful',
        cost_input_per_1m:  2.50,
        cost_output_per_1m: 10.00,
        description:        'Modelo principal da OpenAI. Alta qualidade pra raciocínio.',
        supports_embedding: false,
        context_window:     400_000,
      },
      {
        id:                 'text-embedding-3-small',
        name:               'Embedding 3 Small',
        tier:               'embedding',
        cost_input_per_1m:  0.02,
        cost_output_per_1m: 0,
        description:        'Embeddings 1536 dimensões. Usado pelo módulo de Conhecimento.',
        supports_embedding: true,
      },
      {
        id:                 'text-embedding-3-large',
        name:               'Embedding 3 Large',
        tier:               'embedding',
        cost_input_per_1m:  0.13,
        cost_output_per_1m: 0,
        description:        'Embeddings 3072 dimensões, qualidade superior. (Schema atual usa 1536.)',
        supports_embedding: true,
      },
    ],
  },
]

/** Lookup model by id across all providers. */
export function findModel(modelId: string): { provider: AiProviderDef; model: AiModel } | null {
  for (const p of AI_PROVIDERS) {
    const m = p.models.find(x => x.id === modelId)
    if (m) return { provider: p, model: m }
  }
  return null
}

/** Cost in USD for a given (input, output) token pair on a model. */
export function estimateCostUsd(modelId: string, inputTokens: number, outputTokens: number): number {
  const found = findModel(modelId)
  if (!found) return 0
  const { model } = found
  return (
    (inputTokens  / 1_000_000) * model.cost_input_per_1m +
    (outputTokens / 1_000_000) * model.cost_output_per_1m
  )
}

/** Human label for a tier (used in UI badges). */
export const TIER_LABEL: Record<ModelTier, string> = {
  fast:      'Rápido',
  balanced:  'Equilibrado',
  powerful:  'Potente',
  reasoning: 'Raciocínio',
  embedding: 'Embedding',
}
