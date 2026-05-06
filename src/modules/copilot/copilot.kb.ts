/**
 * Knowledge base do copilot flutuante.
 *
 * Cada entry mapeia routes (patterns Next.js) → docs estruturado.
 * Quando user faz pergunta, backend matcha pathname → injeta entries
 * relevantes no prompt do LLM como contexto.
 *
 * Convenção: ao criar/melhorar feature, adicione/atualize KB entry
 * no MESMO PR. Code review garante que docs nunca ficam stale.
 *
 * V2 (futuro) substitui isso por RAG com embeddings do código.
 */

export interface KbEntry {
  /** Patterns Next.js: ['/dashboard/x', '/dashboard/y/[id]/z'] */
  routes:   string[]
  /** Categoria pra agrupamento na UI (opcional) */
  category?: string
  /** Título da entry — vira heading no prompt */
  title:    string
  /** Markdown formatado. Foca em "como usar" + "como extrair valor". */
  content:  string
  /** Tags livres pra search/cross-reference */
  tags?:    string[]
}

// ════════════════════════════════════════════════════════════════════════
// Onda 1 — Catálogo AI Commerce
// ════════════════════════════════════════════════════════════════════════

const CATALOG_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/produtos', '/dashboard/produtos/[id]/editar'],
    category: 'catalogo',
    title:    'Lista de produtos do catálogo',
    content: `**Catálogo mestre.** Esta tela lista todos os seus produtos.

**Filtros disponíveis** (em \`/dashboard/produtos\`):
- Search por nome/SKU/marca
- Filtros por status (Todos / Prontos / Rascunhos / Analisando / Arquivados)
- Sort: Recentes ↔ A-Z

**Ações rápidas**:
- Click no card → editar produto
- "Novo produto" no header
- Sidebar > Produtos > **IA: Enriquecimento em massa** abre o painel de bulk
- Sidebar > Produtos > **IA: Recomendações** abre o painel diário

**Boas práticas**:
- Mantenha SKU + GTIN preenchidos — sem GTIN o produto perde visibilidade no Mercado Livre
- 3+ fotos é o mínimo recomendado (cada foto vale 1pt no score AI)
- Dimensões + peso são obrigatórios pra publicar no ML`,
    tags: ['catalog', 'list', 'search', 'filter'],
  },
  {
    routes:   ['/dashboard/produtos/[id]/ai'],
    category: 'catalogo',
    title:    'Página AI do produto — score + enriquecimento',
    content: `**Tela central de qualidade do produto.**

**Score 0-100** (badge no header) é composto de 10 componentes:
- Nome bem definido (5pts)
- Descrição ≥200 chars (15pts)
- Marca (5pts), SKU (5pts), GTIN/EAN (5pts)
- Dimensões + peso (15pts)
- Fotos ≥3 (20pts)
- Preço + custo (10pts)
- Categoria ML (10pts)
- Atributos preenchidos (10pts)

Hover no badge mostra breakdown completo.

**Enriquecimento AI** (\`Enriquecer com IA\`):
- Sonnet 4.6 lê os dados + análise visual e gera 9 campos: short/long description, keywords, target_audience, use_cases, pros, cons, SEO keywords, sazonalidade, channel_titles/descriptions
- Custo ~$0.01-0.03 por produto
- Resultado fica em campos \`ai_*\` no produto. UI mostra cards coloridos.
- Pode re-enriquecer quando quiser (dados existentes substituídos)

**Sugestões aplicáveis** (banner amber):
- A IA sugere title/bullets/category novos
- Você compara atual vs sugerido lado a lado
- Botão "Aplicar" sobrescreve o campo oficial. "Aplicar tudo" faz em massa.

**Preview multicanal** (após enriquecer):
- Tabs ML/Shopee/Amazon/Magalu/Loja própria
- Cada tab mostra título + descrição adaptados pro marketplace, com contador de chars vs limite (vermelho se excede)

**Landing page pública**:
- Toggle "Publicar landing" cria página em \`/p/{productId}\` (sem auth)
- Página tem hero, 3 cols (pros/use_cases/cons), CTA pro ML
- Contador de views ao lado do toggle`,
    tags: ['catalog', 'ai', 'enrichment', 'score', 'multicanal', 'landing'],
  },
  {
    routes:   ['/dashboard/produtos/ai-bulk'],
    category: 'catalogo',
    title:    'Enriquecimento em massa',
    content: `**Painel de bulk enrichment** — processa N produtos de uma vez.

**Card de saúde do catálogo** (topo): mostra count por catalog_status
- incomplete (vermelho) — falta name/photos/price
- draft — completo mas sem enriquecimento
- enriching (cyan) — worker processando
- enriched — IA enriqueceu, aguarda revisão
- ready (amber) — todos campos críticos pra ML preenchidos
- published (verde) — em pelo menos 1 canal
- paused — você pausou explicitamente

**3 ações de bulk**:
1. **Enriquecer todos sem score** (amber) — produtos que nunca passaram pela IA
2. **Re-enriquecer score < 60** (orange) — produtos com qualidade baixa
3. **Re-enriquecer score < 40** (red) — críticos

Cada ação abre confirm com custo estimado (~$0.02/produto, max 100/job).

**Job tracking** (após disparar):
- Card de progresso aparece no topo com bar gradient cyan
- Polling 3s atualiza counters (success/error)
- Cost cap automático: se estourar max_cost_usd, job para
- Botão "cancelar" inline

**Boas práticas**:
- Use "score < 60" pra refinar produtos já enriquecidos (worker processa só quem precisa)
- Não dispare 100+ produtos sem revisar uns 5 manualmente primeiro pra calibrar prompt`,
    tags: ['catalog', 'bulk', 'enrichment', 'jobs'],
  },
  {
    routes:   ['/dashboard/produtos/recomendacoes-ia'],
    category: 'catalogo',
    title:    'Recomendações IA do catálogo',
    content: `**O que a IA recomenda hoje.** Painel diário priorizado.

**4 grupos de severity**:
- 🔴 **Atenção crítica** — score < 40
- 🟡 **Avisos** — sem GTIN, sem categoria ML, sem fotos
- 🔵 **Oportunidades** — enriquecidos sem landing publicada, landings sem views
- 🟢 **Top performers** — score ≥80 + landing publicada (use como benchmark)

Cada bucket lista top 5 produtos. Click no produto → \`/dashboard/produtos/[id]/ai\`.

**Como usar**:
- Comece pelo crítico — bloqueia conversão
- Avisos têm impacto real (ex: sem GTIN = 30% menos visibilidade no ML)
- Top performers: copie o que funciona neles (estrutura de descrição, fotos) pros outros`,
    tags: ['catalog', 'recommendations', 'health'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// IA Criativo (F6)
// ════════════════════════════════════════════════════════════════════════

const CREATIVE_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/creative'],
    category: 'creative',
    title:    'IA Criativo — lista de produtos criativos',
    content: `**Esteira de criação de anúncios pra marketplace.** Suba foto + briefing → IA gera tudo.

**Card de uso** (topo): custo total no período, breakdown por operação, top produtos.

**Fluxo geral**:
1. Click "Novo produto" → wizard 3 steps (upload + dados + briefing)
2. IA analisa imagem (Vision Sonnet) — extrai cor, material, riscos visuais
3. Briefing define marketplace + estilo + tom
4. Sistema gera anúncio textual (title, description, bullets, ficha, FAQ, keywords)
5. Você gera 10 imagens otimizadas (com sourceImageUrl da foto original)
6. Opcional: gera 1-5 vídeos curtos (Kling, 5s ou 10s)
7. Aprova manualmente cada imagem/vídeo
8. Publica direto no ML (gated por env flag)

**Vínculo com catálogo**: criativos podem (devem) ser linkados ao produto do catálogo via \`product_id\`. Banner amber quando não vinculado oferece "Salvar no catálogo" (cria products row + vincula).`,
    tags: ['creative', 'ads', 'pipeline'],
  },
  {
    routes:   ['/dashboard/creative/[productId]'],
    category: 'creative',
    title:    'Detalhe do produto criativo',
    content: `**Cockpit do produto criativo** — análise IA + briefings + anúncios + imagens + vídeos.

**Análise IA**: Vision detectou tipo, cor, material, riscos visuais. Botão "Re-analisar" se mudou foto.

**Briefings** (configurações de marketplace + estilo):
- Cada briefing aponta pra 1 marketplace + estilo visual + tom
- 1 produto pode ter N briefings (ex: ML + Shopee versões diferentes)
- Click "Novo anúncio" no briefing dispara geração

**Vídeos gerados**: lista de jobs Kling. Click abre página focada.

**Anúncios gerados**: cada listing é uma versão. Botão "Comparar versões" abre comparador lado a lado.`,
    tags: ['creative', 'product', 'pipeline'],
  },
  {
    routes:   ['/dashboard/creative/[productId]/listing/[listingId]'],
    category: 'creative',
    title:    'Editor de listing — texto do anúncio',
    content: `**Editor do anúncio textual.**

**Lado esquerdo**: editor com 9 seções (title, subtitle, description, bullets, ficha técnica, keywords, tags, FAQ, diferenciais). Cada section editável inline.

**Lado direito**: preview que simula o anúncio + tabs de variantes por marketplace.

**Ações no header**:
- 🟡 **Publicar no ML**: leva pra wizard de publicação (preview → publish gated)
- **Comparar versões**: side-by-side com outra versão (decisão A/B sem publicar 2x)
- **Regenerar**: cria nova versão com instrução adicional opcional
- **Aprovar**: marca status='approved' (badge verde)

**Variantes**: cada listing pode ter N variantes por marketplace. Dropdown gera variante automática quando faltar.

**Versionamento**: regenerate cria nova row com \`parent_listing_id\` apontando pra original. Histórico expandível no fundo.`,
    tags: ['creative', 'listing', 'editor'],
  },
  {
    routes:   ['/dashboard/creative/[productId]/listing/[listingId]/publish/ml'],
    category: 'creative',
    title:    'Publicar no Mercado Livre',
    content: `**Wizard de publicação ML**.

**Estado por banner**:
- 🔒 Cinza "Publicação desabilitada" → setar \`CREATIVE_ML_PUBLISH_ENABLED=true\` no Railway
- ✅ Verde "Publicação ATIVA" → pode publicar (status final = paused, você ativa no ML)

**Fluxo do wizard**:
1. **Imagens**: drag-and-drop pra ordenar, capa = índice 0, max 10
2. **Vídeo** (opcional): radio se múltiplos. Upload best-effort.
3. **Categoria + atributos**: predict automático no título → form dinâmico
4. **Preço/Estoque**: com sugestão de SKU match (se produto exists no catálogo legacy)
5. **Listing type**: free / gold_special / gold_pro
6. **Preview JSON**: mostra payload final + warnings em tempo real (debounce 600ms)

**Publicar**: cria como \`paused\` no ML. Você revisa lá e ativa manualmente. Idempotência via UUID — clique 2x = 1 publicação.

**Histórico de publicações**: cada tentativa fica registrada com status. Botão "sync" force-update do status atual no ML.

**Alerta de degradação**: quando ML rebaixa anúncio (active→inactive/closed/under_review), banner amber aparece. Botão "dispensar alerta" se você já tratou.`,
    tags: ['creative', 'publish', 'ml'],
  },
  {
    routes:   ['/dashboard/creative/[productId]/images/[jobId]'],
    category: 'creative',
    title:    'Pipeline de imagens (10 capas)',
    content: `**Geração de N imagens com IA** (gpt-image-1 com sourceImageUrl da foto do produto).

**Status bar**: progress + cost cap (vermelho ≥100%).

**Grid de imagens**: cada card mostra status + ações (aprovar/rejeitar/regerar).

**Aprovação granular** — chave do produto. Aprove 7, rejeite 3, regere as 3 com prompts diferentes.

**Bulk regenerate**: botão "Regerar N rejeitadas" no header — economiza clicks.

**Notificações**: clica "avisar quando pronto" pra receber notification do browser quando job terminar (~2-3min cada job).

**Custo**: $0.04/imagem. Job de 10 = ~$0.40.`,
    tags: ['creative', 'images', 'pipeline'],
  },
  {
    routes:   ['/dashboard/creative/[productId]/videos/[jobId]'],
    category: 'creative',
    title:    'Pipeline de vídeos (Kling)',
    content: `**Geração de vídeos curtos via Kling AI** (image2video — usa foto do produto como primeiro frame).

**Custo**: kling-v2-master 5s = $0.42, 10s = $0.84.

**Tempo**: cada vídeo demora 1-3min no Kling. Job de 5 vídeos = ~10-15min.

**Aspect ratios**: 1:1 (quadrado), 16:9 (landscape), 9:16 (vertical).

**Aprovação granular** igual imagens. Bulk regenerate disponível.

**Pre-req**: \`KLING_ACCESS_KEY\` + \`KLING_SECRET_KEY\` no Railway (sem isso, falha graciosa com mensagem clara).`,
    tags: ['creative', 'videos', 'kling'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// Landing pública (rota fora do dashboard)
// ════════════════════════════════════════════════════════════════════════

const PUBLIC_ENTRIES: KbEntry[] = [
  {
    routes:   ['/p/[id]'],
    category: 'public',
    title:    'Landing page pública do produto',
    content: `**Página pública sem auth.** Qualquer um com a URL acessa.

**Renderiza só se** \`landing_published=true\`. Caso contrário, 404.

**Conteúdo**:
- Hero com foto + título + descrição curta + preço + CTA
- Long description em prose
- Photos grid (até 4 secundárias)
- 3 cols: pros (verde), use_cases (amber), cons (cinza)
- Cards: target_audience (cyan), sazonalidade (violet)
- Spec table (marca, categoria, condição, dimensões, GTIN)
- CTA repetido no footer

**SEO**: \`generateMetadata\` exporta og:image, keywords, description.

**Privacidade**: backend retorna apenas safe fields — sem cost_price, sem stock exato. \`landing_views\` auto-bumpa em cada render.

**Pra ativar/desativar**: toggle na página AI do produto (\`/dashboard/produtos/[id]/ai\`).`,
    tags: ['public', 'landing', 'seo'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// Atendente IA
// ════════════════════════════════════════════════════════════════════════

const ATENDENTE_IA_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/atendente-ia', '/dashboard/atendente-ia/agentes', '/dashboard/atendente-ia/agentes/[id]'],
    category: 'atendente-ia',
    title:    'Agentes de IA — perfis de atendimento',
    content: `**Agentes** são personas de IA que respondem clientes. Cada agente tem persona, knowledge base, tom, regras de transferência.

**O que configurar**:
- Nome e descrição (visível pro cliente)
- Persona: tom, formalidade, restrições
- KB: arquivos/textos que o agente lê pra responder
- Threshold de confiança: <X% transfere pra humano
- Canais ativos (WhatsApp, widget, etc.)

**Boas práticas**:
- KB enxuta > KB enorme (qualidade > quantidade)
- Teste com perguntas reais antes de ativar
- Reviews periódicos das conversas pra refinar`,
    tags: ['atendente-ia', 'agents', 'persona'],
  },
  {
    routes:   ['/dashboard/atendente-ia/conversas'],
    category: 'atendente-ia',
    title:    'Conversas (Inbox)',
    content: `**Inbox unificada** de conversas com clientes (todos canais).

**Filtros**: por canal, status (aberta/escalada/fechada), agente, data.

**Ações por conversa**:
- Tomar (pula IA, vira humano)
- Transferir pra outro atendente
- Responder com sugestão IA (Sonnet)
- Adicionar tag, marcar resolvido

**Métricas no header**: tempo médio de resposta, taxa de resolução IA, escalações.`,
    tags: ['atendente-ia', 'conversations', 'inbox'],
  },
  {
    routes:   ['/dashboard/atendente-ia/conhecimento'],
    category: 'atendente-ia',
    title:    'Base de Conhecimento (KB)',
    content: `**Documentos que os agentes IA leem** pra responder. Suporta texto livre, FAQ estruturado, links pra docs externos.

**Boas práticas**:
- Use FAQ pra perguntas frequentes diretas
- Texto livre pra políticas, procedimentos
- Mantenha ≤ 50 docs por agente — qualidade > quantidade
- Atualize quando produto/processo mudar`,
    tags: ['atendente-ia', 'kb', 'knowledge'],
  },
  {
    routes:   ['/dashboard/atendente-ia/treinamento'],
    category: 'atendente-ia',
    title:    'Treinamento de agentes',
    content: `**Refina os agentes** com base em conversas reais. Sistema captura interações onde IA errou ou foi corrigida, você revisa e marca certo/errado, padrões aprendidos viram regras.

**Quando treinar**:
- Após 50+ conversas (volume estatístico)
- Quando notar padrão de erro recorrente
- Semanal nos primeiros 3 meses`,
    tags: ['atendente-ia', 'training'],
  },
  {
    routes:   ['/dashboard/atendente-ia/widget'],
    category: 'atendente-ia',
    title:    'Widget de chat (embed)',
    content: `**Chat IA pra colar no seu site/loja**. Cliente conversa, IA responde, conversa vira lead.

**Setup**:
1. Cria widget aqui → gera \`widget_token\`
2. Cola snippet no \`<head>\` do seu site
3. Configurar: cor, posição, mensagem inicial, formulário de captura
4. Vincula a um agente IA

**Boas práticas**:
- Configure \`allowed_origins\` (domínios autorizados)
- Comece com \`auto_reply\` ligado
- Acompanhe em \`/dashboard/atendente-ia/conversas\` filtrando channel='widget'`,
    tags: ['atendente-ia', 'widget', 'embed'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// CRM
// ════════════════════════════════════════════════════════════════════════

const CRM_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/crm/clientes', '/dashboard/crm/customer-hub'],
    category: 'crm',
    title:    'Clientes & Customer Hub',
    content: `**Visão 360 do cliente.** Histórico de pedidos, conversas, campanhas, valor de vida.

**No card do cliente**:
- Dados básicos, LTV, última compra, ticket médio
- Segmentos (VIP, frequente, dormindo)
- Conversas vinculadas (cross-channel)

**Use pra**:
- Preparar atendimento personalizado
- Identificar oportunidades de upsell
- Detectar churn (sem compra > 90d)`,
    tags: ['crm', 'customers', 'ltv'],
  },
  {
    routes:   ['/dashboard/crm/pipeline'],
    category: 'crm',
    title:    'Pipeline (Kanban de oportunidades)',
    content: `**Funil visual de deals.** Drag-and-drop entre estágios.

**Setup**: defina estágios em \`/dashboard/configuracoes\` (Lead → Qualificado → Proposta → Fechado).

**Cada deal**: valor, probabilidade, próxima ação, owner.

**Métricas**: pipeline value, win rate, ciclo médio.`,
    tags: ['crm', 'pipeline', 'deals'],
  },
  {
    routes:   ['/dashboard/crm/pos-venda'],
    category: 'crm',
    title:    'Pós-venda',
    content: `**Acompanhamento depois da compra.** NPS, follow-up, recompra.

**Automações comuns**:
- 7 dias após entrega → pesquisa NPS
- 30 dias → "como está usando?"
- 90 dias → ofertar recompra/upsell

**KPIs**: NPS médio, taxa de recompra, churn pós-1ª compra.`,
    tags: ['crm', 'pos-venda', 'nps'],
  },
  {
    routes:   ['/dashboard/campanhas'],
    category: 'crm',
    title:    'Campanhas WhatsApp/Email',
    content: `**Disparo segmentado** pra base de clientes.

**Setup**:
1. Segmento: todos / VIP / com CPF / custom
2. Template (WhatsApp pré-aprovado ou email livre)
3. Produto destacado
4. Janela: imediato ou agendado
5. A/B opcional (mede CTR)

**Limites**: daily_limit por canal, interval_jitter pra parecer humano, opt-out STOP.

**KPIs**: enviadas, entregues, lidas, respostas, conversões.`,
    tags: ['crm', 'campaigns', 'whatsapp'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// Compras + Pricing
// ════════════════════════════════════════════════════════════════════════

const COMPRAS_PRICING_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/compras/inteligencia'],
    category: 'compras',
    title:    'Inteligência de Compras',
    content: `**Painel de decisão de compras.** IA detecta produtos críticos, sugere quantidade ideal.

**Sinais monitorados**:
- Estoque vs demanda (vendas últimos 30/60d)
- Lead time fornecedor + safety days
- Sazonalidade detectada
- Margem do produto
- Preço competitivo

**Ações sugeridas**: "Comprar X de Y porque...", "Atrasar compra de Z — estoque cobre 45 dias".

**Boas práticas**: revise diários os críticos, mantenha lead times atualizados, foque ABC=A primeiro (80% receita).`,
    tags: ['compras', 'inteligencia'],
  },
  {
    routes:   ['/dashboard/compras/fornecedores'],
    category: 'compras',
    title:    'Fornecedores',
    content: `**Cadastro de fornecedores** com lead time, termos de pagamento, pedido mínimo, performance histórica.

**Use pra**:
- IA de compras calcular safety days
- Comparar fornecedores do mesmo produto
- Auto-gerar pedidos recorrentes`,
    tags: ['compras', 'suppliers'],
  },
  {
    routes:   ['/dashboard/pricing/configuracao', '/dashboard/pricing/analise'],
    category: 'pricing',
    title:    'Pricing — análise vs concorrência',
    content: `**Monitoramento de preço dos concorrentes** + sugestões de ajuste.

**Setup**:
- Cadastre concorrentes por SKU (URLs ML/Shopee)
- Sistema scrapeia periodicamente
- Define regras: "5% abaixo do menor" ou "match preço"

**Análise**: tabela seu vs concorrentes, sinais críticos em vermelho, histórico de preço.

**Chat IA** em \`/dashboard/pricing/chat\` cruza vendas + concorrência + margem.`,
    tags: ['pricing', 'concorrentes'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// Vendas / Pedidos / Atendimento marketplace
// ════════════════════════════════════════════════════════════════════════

const SALES_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/pedidos'],
    category: 'vendas',
    title:    'Pedidos',
    content: `**Lista de pedidos consolidada** de todos canais.

**Filtros**: canal, status, data, valor.

**Atrasados** (sem update X dias) ficam em vermelho.

**Ações**: ver detalhe, marcar problema, vincular a conversa do CRM.`,
    tags: ['pedidos', 'orders'],
  },
  {
    routes:   ['/dashboard/atendimento/perguntas'],
    category: 'atendimento',
    title:    'Perguntas do Mercado Livre',
    content: `**Inbox de perguntas pré-venda** dos compradores ML.

**3 colunas**:
1. Pergunta + produto + comprador
2. Sugestão IA (Sonnet com contexto do anúncio)
3. Ações: editar, encurtar, humanizar, add garantia, resposta pronta

**Auto-resposta**: confidence ≥ 0.70 → envia automático (config em \`/dashboard/configuracoes/ia\`).

**Boas práticas**: revise primeiras 50 antes de auto-send, ajuste tom, use templates pra repetitivas.`,
    tags: ['atendimento', 'ml', 'perguntas'],
  },
  {
    routes:   ['/dashboard/atendimento/reclamacoes'],
    category: 'atendimento',
    title:    'Reclamações',
    content: `**Tickets de reclamação** dos marketplaces (mediation no ML).

**Severidade**: alta (penalização) > média > baixa.

**KPI crítico**: SLA de resposta (ML penaliza > 24h).`,
    tags: ['atendimento', 'reclamacoes', 'sla'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// Ads
// ════════════════════════════════════════════════════════════════════════

const ADS_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/ads', '/dashboard/ads/mercadolivre'],
    category: 'ads',
    title:    'ML Ads — campanhas pagas',
    content: `**Gestão de Product Ads ML.**

**Métricas**: ROAS (receita/gasto), ACOS (gasto/receita), CTR, CPC, conversões.

**Boas práticas**:
- Pause ROAS < 2x (perde dinheiro)
- Aumente budget de ROAS > 5x
- ACOS alvo varia por categoria — descubra break-even (margem)
- Termos negativos cortam custo

**Especialista ML Ads** (sininho flutuante): chat IA com contexto das campanhas. "Qual pausar?", "onde perco dinheiro?".`,
    tags: ['ads', 'ml', 'roas'],
  },
  {
    routes:   ['/dashboard/ads/inteligencia'],
    category: 'ads',
    title:    'Inteligência de Ads',
    content: `**Insights automáticos.** IA detecta oportunidades + alertas.

**Sinais**:
- Campaign fatigue: CTR↓ + CPC↑ (criativo cansado)
- Audience burnout: frequência↑ + CTR↓
- Scaling inefficiency: budget dobrou mas conversões não
- Pixel drift: conversões caíram sem mudar spend

**Severidade**: warning (revisão) vs critical (ação imediata).`,
    tags: ['ads', 'insights'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// Estoque / Logística / Financeiro
// ════════════════════════════════════════════════════════════════════════

const OPS_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/catalogo/estoque'],
    category: 'estoque',
    title:    'Estoque — visão geral',
    content: `**Painel consolidado.**

**Indicadores**:
- Sem estoque (vermelho)
- Crítico (< min_stock)
- OK
- Excesso (> ideal_stock — capital parado)

**stock_mode**: \`shared\` (estoque comum) ou \`isolated\` (separado por canal).

**Ações**: ajuste manual (auditável), sync com marketplace, histórico de movimentações.`,
    tags: ['estoque', 'stock'],
  },
  {
    routes:   ['/dashboard/logistica'],
    category: 'logistica',
    title:    'Logística',
    content: `**Acompanhamento de envios.** Status: aguardando coleta → em trânsito → saiu pra entrega → entregue / extraviado.

**Atrasos** em vermelho (rastreio sem update > 5 dias úteis).

**Ações**: reimprimir etiqueta, solicitar reentrega, abrir reclamação com transportadora.`,
    tags: ['logistica', 'envios'],
  },
  {
    routes:   ['/dashboard/financeiro', '/dashboard/financeiro/resumo', '/dashboard/financeiro/fluxo', '/dashboard/financeiro/dre'],
    category: 'financeiro',
    title:    'Financeiro — resumo + DRE',
    content: `**3 visões**:

1. **Resumo**: receita, despesa, lucro líquido. Top 5 produtos por margem.
2. **Fluxo de caixa**: entradas vs saídas projetadas. Detecta gaps.
3. **DRE**: receita bruta → impostos → líquida → CMV → bruta → despesas → líquida.

**Importante**: dados vêm de pedidos pagos + custos cadastrados. Precisa \`cost_price\` correto pra DRE fazer sentido.`,
    tags: ['financeiro', 'dre'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// Configurações & Integrações
// ════════════════════════════════════════════════════════════════════════

const CONFIG_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/configuracoes', '/dashboard/configuracoes/ia'],
    category: 'configuracoes',
    title:    'Configurações de IA',
    content: `**Provider e modelo por feature.**

**Por feature** (campaign_copy, atendente_response, ml_question_suggest, copilot_help, catalog_enrichment, etc.):
- Provider primário (Anthropic | OpenAI)
- Modelo primário
- Provider/modelo de fallback (opcional)
- Enabled/disabled

**Custos**: ai_usage_log rastreia tudo. Dashboard em \`/dashboard/atendente-ia/analytics\`.

**Auto-resposta ML**: \`ml_question_auto_send\` flag — envia automático se confidence ≥ 0.70.`,
    tags: ['configuracoes', 'ia'],
  },
  {
    routes:   ['/dashboard/integracoes'],
    category: 'configuracoes',
    title:    'Integrações',
    content: `**Conectores externos.**

- **Mercado Livre** (OAuth) — vendas, perguntas, ML Ads
- **Shopee** (em breve)
- **Canva** (OAuth) — editor designs do IA Criativo
- **Kling** (API key) — geração de vídeos
- **Anthropic / OpenAI** (API keys per-org pra LlmService)

**Status verde** = funcionando, **vermelho** = expirou. Reconexão necessária ao expirar token.`,
    tags: ['configuracoes', 'integracoes'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// Geral / cross-cutting
// ════════════════════════════════════════════════════════════════════════

const GENERAL_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard'],
    category: 'general',
    title:    'Visão geral do dashboard',
    content: `**Hub principal do e-Click.** Cards com KPIs, atalhos pras seções principais.

**Sidebar agrupa por área**:
- 📦 **MARKETPLACE** — Comercial, Catálogo, Pricing, Pedidos, Atendimento, Logística, Financeiro
- 🛒 **COMPRAS** — Inteligência, Fornecedores, Importações
- 👥 **CRM** — Clientes, Pipeline, Pós-venda, Campanhas, Comunicação
- 🎯 **PRODUÇÃO** — Tarefas, Conteúdo IA, **IA Criativo**, Biblioteca
- 🤖 **ATENDENTE IA** — Agentes, Conversas, Conhecimento, Treinamento
- 📈 **ADS** — ML Ads, etc.

Use o copiloto flutuante (canto inferior direito) pra dúvidas sobre qualquer tela.`,
    tags: ['general', 'dashboard', 'navigation'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// Export consolidado
// ════════════════════════════════════════════════════════════════════════

export const KB: KbEntry[] = [
  ...GENERAL_ENTRIES,
  ...CATALOG_ENTRIES,
  ...CREATIVE_ENTRIES,
  ...PUBLIC_ENTRIES,
  ...ATENDENTE_IA_ENTRIES,
  ...CRM_ENTRIES,
  ...COMPRAS_PRICING_ENTRIES,
  ...SALES_ENTRIES,
  ...ADS_ENTRIES,
  ...OPS_ENTRIES,
  ...CONFIG_ENTRIES,
]

/** Match Next.js route patterns ('/x/[id]') contra pathname real ('/x/abc-123'). */
export function matchKbEntries(pathname: string): KbEntry[] {
  if (!pathname) return []
  const matches: KbEntry[] = []
  for (const entry of KB) {
    for (const pattern of entry.routes) {
      if (matchRoute(pattern, pathname)) {
        matches.push(entry)
        break
      }
    }
  }
  return matches
}

function matchRoute(pattern: string, pathname: string): boolean {
  // Converte '/x/[id]/y' → regex '^/x/[^/]+/y$'
  const regexStr = '^' + pattern.replace(/\[[^\]]+\]/g, '[^/]+').replace(/\//g, '\\/') + '$'
  return new RegExp(regexStr).test(pathname)
}
