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
  // Cat-5 — sugere a categoria de destino (Meta/Shopee/etc) que melhor casa
  // com a categoria de origem (ML) ao criar um vínculo de categoria.
  category_link_suggest: {
    label:       'Sugestão de vínculo de categoria',
    description: 'Casa a categoria do ML com a categoria equivalente em outro marketplace',
    primary:     { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
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
  // F8 Campaign Center — reasoning enriquecido por LLM em recomendacoes de
  // campanha. Sonnet pra qualidade analitica. Cap diario configuravel
  // por org via ml_campaigns_config.ai_daily_cap_usd.
  ml_campaign_reasoning: {
    label:       'Reasoning de recomendacao (Campaign Center)',
    description: 'Gera analise textual de recomendacao IA pra campanha ML',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
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
    description: 'Gemini Nano Banana (gemini-2.5-flash-image) com fallback gpt-image-1 — multi-image edit confirmado 2026-05-12. NB2 fica como fallback interno (503 high demand).',
    primary:     { provider: 'google', model: 'gemini-2.5-flash-image' },
    fallback:    { provider: 'openai', model: 'gpt-image-1' },
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
  // Onda 4 A2: Coleções de produtos
  collections_generate: {
    label:       'Geração de coleções (A2)',
    description: 'IA agrupa produtos em coleções comerciais por tema/categoria/ocasião',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'openai',    model: 'gpt-5-mini' },
  },
  // ML Pós-venda MVP 1 — classifier roda Haiku (rápido + barato),
  // suggest roda Sonnet (qualidade + adesão a regras de marketplace),
  // transform usa Haiku.
  ml_postsale_classify: {
    label:       'Classificador pós-venda (ML)',
    description: 'Classifica intent/sentiment/urgency/risk de mensagem pós-venda do ML',
    primary:     { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    fallback:    { provider: 'openai',    model: 'gpt-5-nano' },
  },
  ml_postsale_suggest: {
    label:       'Sugestão de resposta pós-venda (ML)',
    description: 'Gera resposta sugerida ≤350 chars para mensagem pós-venda do ML',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'openai',    model: 'gpt-5-mini' },
  },
  ml_postsale_transform: {
    label:       'Transformar tom (ML pós-venda)',
    description: 'Reescreve resposta com tom mais empático ou mais objetivo, mantendo ≤350 chars',
    primary:     { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    fallback:    { provider: 'openai',    model: 'gpt-5-nano' },
  },
  // Intelligence Hub MVP 2 — detector híbrido de exclusão de reclamação ML.
  // Haiku é suficiente: input curto + JSON estruturado.
  ml_claim_removal: {
    label:       'Exclusão de reclamação (ML pós-venda)',
    description: 'Analisa se mensagem do comprador indica que reclamação pode ser excluída',
    primary:     { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    fallback:    { provider: 'openai',    model: 'gpt-5-nano' },
  },
  // Radar IA C3 — insight de Concorrentes Vinculados. Lê preço/visitas/venda
  // estimada dos concorrentes e gera uma leitura curta e acionável. Haiku pra
  // latência baixa + custo mínimo (roda ao abrir a tela de comparação).
  radar_competitor_insight: {
    label:       'Insight de concorrente (Radar)',
    description: 'Lê movimentos de preço/visitas/venda estimada dos concorrentes vinculados e gera uma leitura acionável',
    primary:     { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    fallback:    { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  },
  // Onda 4 A4: Copiloto da Loja (admin assistant)
  store_copilot: {
    label:       'Copiloto da Loja (A4)',
    description: 'Assistente de comando natural que classifica intent + dispara tools (pricing/kits/ads/etc.)',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  },
  // Loja Propria Fase 2: Designer de loja com IA. Sonnet pra coerencia de
  // design (paleta + layout) + saida JSON estruturada. Fallback OpenAI mini.
  storefront_design: {
    label:       'Designer de loja (IA)',
    description: 'Gera a receita de design da loja (tema + blocos + layout) a partir de um prompt',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'openai',    model: 'gpt-5-mini' },
  },
  // Loja Propria Fase 6 — imagem de banner/hero da loja gerada por IA.
  storefront_hero_image: {
    label:       'Banner da loja (IA)',
    description: 'Gera a imagem de banner/hero da Loja Propria',
    primary:     { provider: 'google', model: 'gemini-2.5-flash-image' },
    fallback:    { provider: 'openai', model: 'gpt-image-1' },
  },
  // Loja Propria AH — Ambientador IA ("Veja no seu espaço"). Coloca o produto
  // na foto do ambiente do cliente preservando cena + produto (Nano Banana é
  // excelente nesse "place this product in this room"). Fallback gpt-image-1 edits.
  storefront_room_compose: {
    label:       'Ambientador IA (Veja no seu espaço)',
    description: 'Aplica o produto na foto do ambiente do cliente, fiel à cena e ao produto (só corrige exposição/ruído/inclinação)',
    primary:     { provider: 'google', model: 'gemini-2.5-flash-image' },
    fallback:    { provider: 'openai', model: 'gpt-image-1' },
  },
  // F12 Fulfillment — triagem de avaria por foto (visão, exige anthropic).
  // Best-effort: assistivo, não bloqueante. OFF por padrão (toggle por org).
  fulfillment_damage_triage: {
    label:       'Triagem de avaria por foto (Fulfillment)',
    description: 'Vision: classifica severidade (minor/major/total_loss) + destino sugerido a partir da foto da avaria',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    null,
  },
  // F12 Fulfillment — conferência do pacote por foto (visão, exige anthropic).
  fulfillment_pack_verify: {
    label:       'Conferência de pacote por foto (Fulfillment)',
    description: 'Vision: confere se os itens esperados aparecem na foto do pacote antes de fechar a expedição',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    null,
  },
  // F12 Wave IA — sugestão de montagem de onda de separação. Heurística faz o
  // score (SKU em comum × transportadora × SLA); o LLM só escreve um racional
  // curto em pt-BR (best-effort, não bloqueia). Haiku pra latência + custo baixo.
  fulfillment_wave_suggest: {
    label:       'Sugestão de onda (Separação)',
    description: 'Justifica em 1-2 frases por que agrupar pedidos numa onda de separação é eficiente (SKU em comum, transportadora, prazo)',
    primary:     { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    fallback:    { provider: 'openai',    model: 'gpt-5-nano' },
  },
  storefront_room_recolor: {
    label:       'Provador de cor/acabamento IA',
    description: 'Recolore o produto numa cena já ambientada pra bater com a variante escolhida, mantendo cena e posição idênticas',
    primary:     { provider: 'google', model: 'gemini-2.5-flash-image' },
    fallback:    { provider: 'openai', model: 'gpt-image-1' },
  },
  // Telemetria — e-Click Insights (Fase 4). Analisa agregados de uso e gera
  // insights estruturados pro founder. Sonnet pra qualidade analítica + jsonMode.
  telemetry_insights: {
    label:       'Insights de produto (Telemetria)',
    description: 'Analisa agregados de uso (quedas, churn, abandono de tarefa, padrões saudáveis) e gera insights acionáveis pro founder',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'openai',    model: 'gpt-5-mini' },
  },
  // F12 Onda E — sugestão da embalagem ideal. Heurística escolhe (volume × itens);
  // o LLM só escreve um racional curto (best-effort). Haiku pra latência + custo baixo.
  fulfillment_packaging_suggest: {
    label:       'Sugestão de embalagem (Fulfillment)',
    description: 'Justifica em 1 frase a embalagem ideal pro pedido (quantidade de itens × tamanho)',
    primary:     { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    fallback:    { provider: 'openai',    model: 'gpt-5-nano' },
  },
  // AI Visibility OS — GEO Score (Sprint 2). Audita UMA dimensão do listing e dá
  // nota 0-10 com reasoning + evidence (jsonMode). 7 dimensões via LLM por
  // auditoria (a 8ª, crawler_access, é determinística via robots.txt). Sonnet
  // pra qualidade analítica; fallback OpenAI mini.
  ai_visibility_geo_score: {
    label:       'GEO Score (AI Visibility)',
    description: 'Audita dimensões do listing (título, descrição, atributos, reviews, FAQ, etc) e dá nota 0-10 pra visibilidade nos motores de IA',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'openai',    model: 'gpt-5-mini' },
  },
  // AI Visibility OS — recomendações do GEO Score (Sprint 2 Parte 2). 1 chamada
  // batched gera até 5 fixes acionáveis (antes/depois) pras dimensões fracas.
  ai_visibility_geo_recommendations: {
    label:       'Recomendações GEO (AI Visibility)',
    description: 'Gera os top fixes acionáveis (severidade + antes/depois) pras dimensões com nota baixa do GEO Score',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'openai',    model: 'gpt-5-mini' },
  },
  // AI Visibility — geo-optimizer (Sprint 2). Reescreve título/descrição pra
  // melhorar a visibilidade em IA. Sonnet pra qualidade de copy + estrutura.
  ai_visibility_title_rewrite: {
    label:       'Reescrita de título (AI Visibility)',
    description: 'Gera 3 variações de título (transacional/comparativa/informacional) otimizadas pra motores de IA',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'openai',    model: 'gpt-5-mini' },
  },
  ai_visibility_description: {
    label:       'Reescrita de descrição (AI Visibility)',
    description: 'Reescreve a descrição em estrutura data-dense (resumo, specs, para quem serve/não serve, comparativo, CTA)',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'openai',    model: 'gpt-5-mini' },
  },
  // Rank Simulator (método E-GEO): gera queries de shopper + re-ranqueia o produto
  // contra concorrentes, simulando o motor de IA. Mede posição antes×depois.
  ai_visibility_rank_simulator: {
    label:       'Simulador de Ranking GEO (AI Visibility)',
    description: 'Gera queries realistas de comprador e simula o re-ranking do produto vs concorrentes num motor de IA, medindo a posição',
    primary:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback:    { provider: 'openai',    model: 'gpt-5-mini' },
  },
} as const

export type FeatureKey = keyof typeof FEATURE_REGISTRY

export type Provider = 'anthropic' | 'openai' | 'google'

export const FEATURE_KEYS = Object.keys(FEATURE_REGISTRY) as FeatureKey[]
