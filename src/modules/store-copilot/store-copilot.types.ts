/** Onda 4 / A4 — Copiloto da Loja (admin assistant). */

export type StoreCopilotIntent =
  | 'answer'                      // só responde (sem ação)
  | 'clarification'                // precisa pedir mais info
  | 'analyze_pricing'              // disparar análise IA de preços
  | 'generate_collections'         // gerar coleções IA
  | 'generate_kits'                // gerar kits IA
  | 'generate_social_content'      // gerar conteúdo social
  | 'create_ads_campaign'          // criar campanha ads
  | 'pause_ads_campaign'           // pausar campanha
  | 'enrich_products'              // enriquecer produtos
  | 'analyze_store'                // rodar análise de automação
  | 'list_pending_actions'         // listar pending actions
  | 'get_sales_summary'            // resumo de vendas
  | 'get_top_products'             // top produtos por algum critério

export interface StoreCopilotResponse {
  intent:                StoreCopilotIntent
  message:               string         // o que o copiloto vai dizer ao user
  requires_confirmation: boolean
  params:                Record<string, unknown>
  // Preenchido pelo dispatcher após executar
  executed?:             boolean
  execution_result?:     Record<string, unknown>
  cost_usd?:             number
}

export interface ChatMessage {
  role:    'user' | 'assistant'
  content: string
}
