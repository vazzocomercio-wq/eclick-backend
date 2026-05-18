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
  {
    routes:   ['/dashboard/radar', '/dashboard/radar/[id]'],
    category: 'catalogo',
    title:    'Radar IA — disputa de catálogo e teto de preço',
    content: `**e-Click Radar IA.** Monitora a concorrência por produto de catálogo no Mercado Livre — quem está ganhando a ponta, preços dos concorrentes e demanda estimada.

**Status do catálogo** (coluna "Catálogo"): Ganhando / Empatado / Perdendo. Vem ao vivo da API do ML (price_to_win); enquanto a coleta diária não roda, cai num heurístico de menor preço.

**Ajustar preço** (modal): puxa custo, imposto, tarifa ML e frete reais pra calcular a margem em qualquer preço. Altera o preço do anúncio no ML de verdade.
- **Perdendo** → mostra o **"Preço pra ganhar"**: o valor que o ML diz que você precisa pra retomar a ponta.
- **Ganhando** → mostra o **"Teto do catálogo"**: o preço do concorrente mais barato − R$ 0,01. É até onde dá pra **subir** o preço e seguir ganhando — protege margem sem perder a disputa. A margem nesse teto já aparece no card.

**Folga** (na lista, itens que você ganha): \`↑ R$ X\` em verde = quanto dá pra subir até alcançar o concorrente mais barato.

**Como usar pra proteger margem**: se você está ganhando folgado (preço bem abaixo do concorrente), suba o preço em direção ao teto — você ganha margem sem perder a ponta.

**Ressalvas**: o teto usa os preços da última coleta do Radar (não é ao vivo). E o vencedor do catálogo no ML não é só preço — reputação, frete grátis e Full também pesam; ser o mais barato é o fator mais forte, então o teto é um piso seguro, não garantia absoluta.`,
    tags: ['radar', 'catalogo', 'concorrencia', 'preco', 'teto', 'price-to-win', 'margem'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// IA Criativo (F6)
// ════════════════════════════════════════════════════════════════════════

const CREATIVE_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/catalogo/anuncios/mercadolivre'],
    category: 'catalogo',
    title:    'Anúncios Mercado Livre — listagem + vínculo em massa',
    content: `**Lista TODOS os anúncios das contas ML conectadas** desta organização (multi-conta). Tabs: Ativos / Pausados / Finalizados / Em revisão.

**Filtros**:
- Search por Título / SKU / MLB ID
- Filtros avançados (toggle): tipo (Premium/Ouro/Clássico), logística (Full/Self/Drop-off), promoção, **sem vínculo** (anúncios SEM produto do catálogo linkado), sem custo, sem foto, estoque 0+ativo, sem campanha, saúde com problema
- Chips no topo mostram os filtros ativos

**Por anúncio (card)**:
- Thumbnail + título + MLB id (Copy) + SKU (Copy) + badge da CONTA (multi-conta)
- Badges de tipo (Full/Catálogo/Premium/Ouro/Clássico)
- Preço + tarifa ML calculada + líquido
- Estoque INLINE editável quando vinculado a produto (input direto)
- Health score semi-gauge
- Badge "📦 Produto vinculado" quando há entry em product_listings

🔗 **Vincular anúncios a produto (em massa)** — botão roxo "Vincular a produto":
1. Aplica filtro "Sem vínculo" pra ver só não-vinculados (recomendado)
2. Marca os checkboxes dos anúncios desejados (multi-conta OK — pode misturar contas no mesmo batch)
3. Click no botão "Vincular a produto" (toolbar OU barra flutuante inferior)
4. Modal abre com breakdown por conta + busca de produtos do catálogo
5. Escolhe UM produto + define qtd por unidade (para kits, ex: produto = 1 unidade do kit-de-3 = 3)
6. Confirma → backend grava \`product_listings\` rows com \`account_id = seller_id\` por anúncio
7. Idempotente: se vínculo já existe (race), retorna \`skipped\` sem duplicar

**O que ganhamos com o vínculo**:
- Pedidos vindos do anúncio puxam custo + imposto do produto automaticamente
- Estoque centralizado (input INLINE no card edita o estoque shared)
- Margem real por venda passa a ser calculada
- KPIs "X pedidos sem custo" / "X anúncios sem vínculo" caem
- Sugestão automática de OC (compras) considera demanda agregada de todos os listings linkados

📦 **Criar produtos a partir de anúncios** — botão cyan "Criar Produtos":
- Outro caminho: anúncio que ainda NÃO existe no catálogo → cria products row + já vincula
- Multi-conta OK: cada anúncio carrega seu seller_id

🔄 **Sincronizar ML** (botão topo direito): re-puxa anúncios das contas conectadas. Idempotente.

**Health score** (gauge no card): 80+ = verde, 60-79 = amber, <60 = vermelho. Reflete preço competitivo + estoque + fotos + campanha + variações + reputação. Click no card abre detalhe.

**Multi-conta**: badge colorido por conta (palette baseada em seller_id). Vincular anúncio de uma conta NÃO afeta anúncios da outra — \`account_id\` é a chave que separa.

**Disputa de catálogo + ajuste de preço** (anúncios de catálogo): cada card mostra o status ao vivo — 🏆 Ganhando / 🤝 Empatado / 📉 Perdendo (API price_to_win do ML).
- **Perdendo** → botão "Ganha o catálogo a R$ X →": o preço que o ML pede pra retomar a ponta. O painel de margem mostra a margem nesse preço.
- **Ganhando** → botão "Teto do catálogo: R$ X →": o preço do concorrente mais barato − R$ 0,01, ou seja, até onde dá pra SUBIR o preço e seguir ganhando. O painel mostra a "Margem no teto do catálogo".
- Click no preço (ou nesses botões) abre a edição inline — altera o preço no ML de verdade.
- Use o teto pra proteger margem: ganhando folgado (preço bem abaixo do concorrente)? suba o preço em direção ao teto.`,
    tags: ['anúncios', 'listings', 'ml', 'vinculo', 'bulk-link', 'multi-conta', 'product_listings', 'catalogo', 'teto', 'preco', 'price-to-win'],
  },
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

**Lado esquerdo**: editor com seções (title, subtitle, description, bullets, atributos ML, keywords, tags, FAQ, diferenciais). Cada section editável inline.

**Atributos do anúncio**: painel \`MlAttributesPanel\` — obrigatórios + recomendados da categoria ML, com preenchimento por IA e o toggle "Não se aplica" nos recomendados (mesmo componente da tela de publicação). Os atributos ficam no campo \`creative_listings.ml_attributes\` (fonte ÚNICA: id→value_id/value_name, value_id "-1" = não se aplica) — editor e publicação compartilham. Antes os atributos viviam em dois lugares (ficha técnica \`technical_sheet\` no editor + estado efêmero na publicação); agora é um campo só.

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
1. **Conta(s) do Mercado Livre**: escolhe em qual(is) conta(s) ML o anúncio sobe (ver abaixo)
2. **Imagens**: drag-and-drop pra ordenar, capa = índice 0, max 10
3. **Vídeo** (opcional): radio se múltiplos. Upload best-effort.
4. **Categoria + atributos**: predict automático no título → form dinâmico dos obrigatórios
5. **Atributos recomendados**: preenchidos por IA, com "Não se aplica" (ver abaixo)
6. **Markup / Precificação**: calcula o preço de venda pela margem alvo (ver abaixo)
7. **Preço/Estoque**: com sugestão de SKU match (se produto exists no catálogo legacy)
8. **Listing type**: free / gold_special / gold_pro
9. **Preview JSON**: mostra payload final + warnings em tempo real (debounce 600ms)

**Atributos recomendados + "Não se aplica"**: além dos obrigatórios, a categoria tem atributos recomendados (Potência, Formato, fontes de luz, ANATEL, etc.). A IA preenche esses a partir do produto/anúncio (\`POST /creative/listings/:id/ml-attributes/suggest\`, feature \`creative_listing\`) — roda automático ao abrir a tela. O que a IA não determina vira "Não se aplica" (\`value_id: "-1"\` no payload ML — convenção do ML pra contar o campo como preenchido). Cada campo tem o toggle "Não se aplica" editável. Os 4 obrigatórios NUNCA recebem "não se aplica" (o ML exige valor real). Botão "Preencher com IA" refaz a sugestão.

**Atributos = fonte única (\`ml_attributes\`)**: os atributos editados aqui e no editor de anúncio são o MESMO campo \`creative_listings.ml_attributes\` — a publicação carrega o que foi salvo no editor (não re-roda a IA se já tem valor) e salva de volta (auto-save + no publish). O preview lista como pendência qualquer recomendado sem valor nem flag.

**Seleção de conta (multi-conta)**: quando a org tem mais de uma conta ML conectada, o painel "Conta(s) do Mercado Livre" lista todas. Marque uma, várias ou todas — o anúncio é publicado em cada conta selecionada (uma publicação por conta, cada uma com seu MLB). Por padrão vem pré-selecionada a conta mais antiga (principal). O histórico de publicações mostra a conta de cada anúncio. Antes disso o publish pegava a conta com \`updated_at\` mais recente — podia subir na conta errada silenciosamente.

**Painel Markup / Precificação**: dimensiona o preço de venda a partir de — margem de contribuição alvo (%), custo do produto/CMV (R$), custo de venda do marketplace/tarifa (%), imposto (%), reserva para promoção (%), custo de frete e desconto para preço de atacado (%). O preço cheio é calculado para que MESMO numa promoção do tamanho da reserva a margem alvo se mantenha: \`precoPromo = (CMV + frete) ÷ (1 − tarifa − imposto − margemAlvo)\`, \`precoVenda = precoPromo ÷ (1 − reservaPromo)\`. A tarifa vem pré-preenchida do tipo de anúncio (16% Premium / 11,5% demais) e é editável. Botão "Aplicar como preço" joga o valor no campo Preço. O resultado é reverificado pelo motor canônico de margem — a margem exibida é a real, não a de entrada.

**Frete no markup**: marcando "Frete grátis por conta do vendedor", o painel busca o custo real do frete no ML (\`GET /users/{seller}/shipping_options/free\`) por largura/altura/profundidade/peso da embalagem — pré-preenchidos do produto. O ML aplica internamente as regras de faixa de preço (o custo dá um salto quando o item passa do valor mínimo de frete grátis); abaixo do mínimo o ML devolve o custo menor da tabela. Como o frete depende do preço e o preço depende do frete, o botão "Buscar custo de frete" itera até convergir. O frete entra como custo na formação do preço. Desmarcado = o comprador paga o frete, custo zero.

**Preço de atacado (B2B)**: campos "Desconto p/ preço de atacado (%)" + "Qtd. mínima p/ atacado (un)" calculam \`precoAtacado = precoPromo × (1 − descontoAtacado)\` válido a partir da quantidade mínima. O painel emite esse valor pra publicação, que o ENVIA AUTOMATICAMENTE ao ML pós-publicação (\`POST /items/{id}/prices/standard/quantity\` com \`conditions.min_purchase_unit\` ≥2 + \`context_restrictions: [channel_marketplace, user_type_business]\`). Fail-isolated: se falhar, o anúncio fica publicado e o motivo vai pro \`error_message\`. Só funciona para sellers com a tag \`business\`. Máx 5 faixas. Por regra do ML o preço de atacado tem que ser menor que o de promoção, então o desconto incide sobre o preço de promoção.

**Atributos conditional_required**: atributos com a tag \`conditional_required\` (ex: "Unidades por kit"/UNITS_PER_PACK, Voltagem, GTIN) entram como OBRIGATÓRIOS — não aceitam "não se aplica" (o ML rejeita). Atributo \`number_unit\` sem unidade ("15") é normalizado pro \`default_unit\` da categoria ("15 W") antes de ir pro payload.

**Desconto de frete por reputação**: a chamada de frete passa \`listing_type_id\` — sem ele o ML devolveria o custo BRUTO (sem desconto), superfaturando o frete em até 2× para contas Mercado Líder. Com o \`listing_type_id\`, o ML aplica o desconto de reputação (varia por item, 30–50%) e devolve o custo já líquido. O painel mostra o desconto aplicado ("de R$X com 50% de desconto Mercado Líder").

**Publicar**: cria como \`paused\` no ML. Você revisa lá e ativa manualmente. Idempotência via UUID — clique 2x = 1 publicação.

**Histórico de publicações**: cada tentativa fica registrada com status. Botão "sync" force-update do status atual no ML.

**Alerta de degradação**: quando ML rebaixa anúncio (active→inactive/closed/under_review), banner amber aparece. Botão "dispensar alerta" se você já tratou.`,
    tags: ['creative', 'publish', 'ml', 'markup', 'precificacao', 'preco', 'margem'],
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
    routes:   ['/dashboard/creative/templates', '/dashboard/creative/templates/new', '/dashboard/creative/templates/[id]'],
    category: 'creative',
    title:    'Templates de imagens IA — controle visual da geração',
    content: `**Esteira editável de geração de imagens.** Cada template define N slots (posições) — cada slot tem um prompt curto + até 10 imagens de inspiração visual + regras de match dinâmico. A IA usa essas refs como moodboard direto, não só texto.

**Filosofia**: refs visuais carregam a estética, prompt só ancora diretrizes não-negociáveis (logo, hierarquia, fidelidade ao produto). Prompt longo (>900 chars) compete com refs e degrada resultado — UI mostra contador.

**Lista** (\`/templates\`): cards de templates da org. Badge "default" no ativo. Multi-categoria ML — 1 template atende lista de \`category_ml_ids[]\`. Match no momento da geração, em ordem:
1. \`category_exact\` — produto vinculado ao catálogo + \`catalog.category_ml_id\` ∈ \`template.category_ml_ids[]\`. Empate vai pro template MAIS específico (menor array).
2. \`category_text\` — casa \`creative_products.category\` (texto livre digitado pelo user no wizard) contra \`template.name\` por substring case-insensitive sem acento. "Pendente Pequeno" ganha de "Pendente" quando user digita "pendente pequeno" (mais longo = mais específico).
3. \`org_default\` — fallback no template com \`is_default=true\`.
4. \`most_recent\` — último criado.

\`brand_voice\` no template + \`category_ml_ids[]\` são **obrigatórios** pra auto-pick funcionar bem. Plantão: produto novo sem \`product_id\` (não vinculado ao catálogo) só dá match via \`category_text\` — então preenche o campo "Categoria" no wizard com o tipo do produto (Plafon, Arandela…).

**Editor por slot** (\`/templates/[id]\`):
- Header colapsível por slot: #N · Nome · badge "X refs" · botão **Testar** · botão deletar
- Drag-drop pra reordenar slots (renumera 1..N automático)
- **Testar slot** → modal escolhe produto → gera 1 imagem isolada (POST \`/prompt-templates/:id/positions/:N/test\`). Não cria job, só upload temporário em \`creative/tests/\`. ~15-40s.
- **Grid visual de refs** dentro do card: thumbnails das refs vinculadas + drop-zone pra upload direto no slot + botão "Da galeria" pra picker multiselect.
- Upload no slot cria \`creative_reference_images\` com tags automáticas \`slot:N\` + slug do nome + \`default_for_positions:[N]\`.
- **Reference match** accordion configura fallback dinâmico (by_category, by_position_default, by_tags) quando refs fixas vazias.
- Variáveis interpoláveis: \`{product_name}\`, \`{material}\`, \`{primary_color}\`, \`{dimensions}\`, \`{ambient_label}\`, \`{commercial_differentials}\`, etc — chips clicáveis inserem no cursor.

**Botão "Testar slot"** é a chave da iteração rápida: ajusta prompt OU troca refs → testa só esse slot → sem rodar as 11. Custo ~$0.04 por teste.

**Quando criar template novo**: por categoria de produto (Lustres / Pendentes / Abajures separados). Multi-select de categorias ML define quais produtos caem nesse template. Sem template match → fallback Claude Sonnet gera prompts on-demand (qualidade inferior).`,
    tags: ['creative', 'template', 'editor', 'references', 'slot-test', 'image-generation', 'prompt'],
  },
  {
    routes:   ['/dashboard/creative/references'],
    category: 'creative',
    title:    'Galeria de referências — moodboard da org',
    content: `**Pool de imagens de inspiração usadas em geração IA.** Refs ficam na tabela \`creative_reference_images\` e são selecionadas dinamicamente por:
- Slot específico via \`use_reference_ids[]\` no template (upload pelo editor de template já vincula)
- Categoria ML via \`category_ml_ids[]\` (match com produto)
- Tags via \`tags[]\` (configurado em \`reference_match.by_tags\`)
- Position default via \`default_for_positions[]\` (ex: ref serve slots #3 e #5)

**Curated**: refs com \`is_curated=true\` são compartilhadas pela plataforma — todas as orgs podem usar mas não editar. Sua org só edita as próprias.

**Upload**: drag-drop OU file picker → signed URL → PUT direto Storage → metadata row. Drawer editor edita tags/categoria/posições após criar.

**Bulk actions**: ativar/desativar/apagar várias de uma vez. Filtros por tag, categoria, ambiente, ativo.

**Vínculo com template**: upload pelo editor de template (\`/templates/[id]\`) já vem com \`default_for_positions\` correto. Aqui na galeria você ajusta refs já existentes.`,
    tags: ['creative', 'references', 'gallery', 'upload', 'moodboard'],
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
    title:    'Pedidos — visão consolidada multi-canal',
    content: `**Lista de pedidos consolidada** de todas as suas contas ML.

**Abas (tabs)** — filtro server-side:
- **Abertas** — pedidos ativos sem envio terminal
- **Em preparação** — \`shipping_status in (handling, ready_to_ship)\`
- **Despachadas** — \`shipped\` ou \`in_transit\`
- **Pgto pendente** — \`payment_required / in_process\`
- **Flex** — só logística \`self_service\`
- **Encerradas** — \`delivered / not_delivered / cancelled\`
- **Mediação** — pedidos com \`mediations\` ou tag \`mediation_in_progress\`

**Cada card mostra**:
- 📦 Foto do produto + título + 1x quantidade + preço unitário
- 🏷️ SKU + MLB# + variações ("Cor: Branco · Voltagem: 127/220V")
- 📊 "X disponíveis após esta venda"
- 🛒 **Carrinho #pack_id** quando ML agrupou
- 🎟️ Badge **Cupom** quando teve estorno de campanha
- 📣 Badge **Publicidade** (Mercado Ads)
- ⏱ Limite postagem + Estimativa entrega
- 💰 Valor pago / Frete vendedor / Tarifa ML / Lucro bruto / Custo + Imposto / Margem

**"Mais detalhes" expande** 4 blocos:
- **Comprador**: nome, CPF (quando ML libera), endereço fiscal, email, @username, ID
- **Pagamento**: cartão/parcelas/valor, vários payments se aplicável
- **Endereço de entrega**: rua/número/complemento/bairro/cidade/CEP (com fallback do billing_address quando ML não devolveu receiver_address)
- **Envio**: ID, Logística, Status, Substatus, Pr. postagem, Prev. entrega, **Quem recebe**, **Rastreio**, Tipo entrega

**Carregamento**:
- Lista vem do DB (\`/orders/list\` — instantâneo)
- 1ª visita ao card detalhado faz enrichment ML (~2-3s) → busca thumbnail + payments + receiver_address + tracking
- 2ª visita é instantânea (dados persistem em \`raw_data\`)
- Cap de 8 enrichment fetches/page pra não estourar quota — backlog processa progressivamente

**Multi-conta cross-conta** (fan-out):
- Org com várias contas ML conectadas: thumbnails + billing-info varrem todos os tokens até resolver
- Botão 🔄 no card do comprador faz refetch com fan-out (até achar CPF em alguma conta)
- Ainda assim alguns pedidos não terão CPF (LGPD ML, ou pedido fora da janela 90 dias)

**Bulk Excel CMV/Imposto**: botão "Subir planilha" no \`/produtos\` aceita .xlsx/.csv com colunas SKU, PREÇO (CMV), IMPOSTO (%) — atualiza catalogo em massa.

**Cálculo financeiro correto**:
- Frete vendedor vem de \`/shipments/{id}/costs\` campo \`senders[0].cost\` (cost real do vendedor)
- NÃO usa \`gross_amount\` (frete bruto antes de descontos) — isso era um bug antigo já corrigido
- Tarifa ML = \`sale_fee\` por item
- Lucro bruto = total − tarifa − frete vendedor
- Margem contribuição = lucro bruto − custo (CMV) − imposto`,
    tags: ['pedidos', 'orders', 'multi-conta', 'enrichment', 'cpf', 'rastreio'],
  },
  {
    routes:   ['/dashboard/atendimento/perguntas'],
    category: 'atendimento',
    title:    'Perguntas do Mercado Livre (pré-venda)',
    content: `**Inbox de perguntas pré-venda** dos compradores ML — antes do pedido.

**Card "Prazo de resposta"** no topo (NOVO em 2026-05-07, espelha tela ML nativa):
- Tempo médio últimos 14 dias com badge: 🟢 verde (<1h) ou 🔴 vermelho (>1h)
- Mensagem de impacto: "Você pode vender até 10% mais respondendo em até 1h" (só aparece se média >1h)
- **Bar chart por período** com 3 barras: Seg-Sex 9-18h, Seg-Sex 18-00h, Sáb-Dom
  - Verde <30min, amarelo <60min, vermelho >60min
  - Linha cinza vertical na barra marca o cutoff de 60min (SLA ML)
- **Multi-conta**: breakdown por conta abaixo do agregado quando 2+ contas. Cada conta tem nickname + total respostas + média
- Endpoint: \`GET /ml/questions/perf-stats\` com fan-out cross-conta. Cada conta puxa /questions/search?status=ANSWERED limit=50 paginado até 14d (até 6 páginas/conta)

**Como chega cada pergunta** (sprint MVP 1 ML Pós-venda):
- ML envia webhook em segundos pra \`POST /ml/webhook\` (topic=questions)
- Backend identifica seller_id → org → roda \`MlAiCoreService.suggestQuestion\`
- Sonnet 4.6 lê pergunta + título/preço/estoque + histórico P&R + persona → gera resposta
- Sugestão fica em \`ml_question_suggestions\` (status=pending)
- **Não há mais cron de polling** — webhook é fonte única (política realtime-first)

**6 KPI cards**: Sem resposta, Respondidas hoje, Tempo médio, SLA <1h, Resp. automáticas (24h), Aprovação IA (30d).

**3 colunas workspace**:
1. Lista de perguntas + busca
2. Detalhe + textarea + Enviar (Cmd+Enter)
3. Painel IA: sugestão + 4 transformações (Encurtar / Humanizar / Add garantia / Resp. pronta)

**Auto-resposta**: confidence ≥ 0.70 → envia automático sem revisão humana
- Configurar em \`/dashboard/configuracoes/ia\` (toggle \`ml_question_auto_send\`)
- Recomendação: revisar primeiras 50 antes de ligar auto-send

**Pós-venda é outra tela**: questões de COMPRADORES JÁ COMPRARAM (envio, defeito, NF) ficam em \`/dashboard/ml-postsale\`, não aqui.`,
    tags: ['atendimento', 'ml', 'perguntas', 'pre-venda', 'webhook', 'realtime', 'sla', 'multi-conta'],
  },
  {
    routes:   ['/dashboard/atendimento/reclamacoes'],
    category: 'atendimento',
    title:    'Reclamações ML',
    content: `**Tickets de reclamação** dos marketplaces (mediation no ML).

**Severidade**: alta (penalização) > média > baixa.

**KPI crítico**: SLA de resposta (ML penaliza > 24h úteis — perde direito de pedir exclusão da reclamação).

**Painel inteligente cobre o mesmo terreno**: \`/dashboard/inteligencia/ml\` lista todas reclamações abertas + candidatos a exclusão de reclamação detectados pela IA + reputação atualizada. Recomendação: usar o painel de inteligência como ponto de partida diário.

**Disparos automáticos** (Intelligence Hub vertical ML — sprint 2026-05-07):
- Reclamação aberta → alerta WhatsApp pro gestor cadastrado
- Mediação iniciada → alerta crítico imediato
- Comprador disse "abri por engano" → candidato a exclusão detectado pela IA híbrida (regex + Haiku)`,
    tags: ['atendimento', 'reclamacoes', 'sla', 'mediation', 'intelligence'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// ML Pós-venda IA + Intelligence Hub vertical ML (sprints 2026-05-07)
// ════════════════════════════════════════════════════════════════════════

const ML_POSTSALE_INTELLIGENCE_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/ml-postsale'],
    category: 'atendimento',
    title:    'Pós-venda IA — Inbox de mensagens ML após o pedido',
    content: `**Painel principal de atendimento pós-venda do Mercado Livre** (entregue 2026-05-07).

**O que cobre**: mensagens dentro de pedidos JÁ feitos — dúvidas sobre envio, problemas com produto, pedido de NF, reclamações em formação. **Diferente de \`/dashboard/atendimento/perguntas\`** (perguntas pré-venda em anúncios).

**Layout 3 colunas**:
1. **Lista de conversas** (esquerda 320px): filtro por SLA (em dia / atenção / alerta / urgente / estourou), busca, badge de não lidas, ordenação automática por urgência
2. **Conversa + Editor IA** (centro): histórico (comprador esquerda / vendedor direita), caixa cyan com sugestão IA classificada (intent + sentiment + urgency + risk), contador 350 chars, botões Enviar / Pedir nova sugestão / Tom mais empático / Tom mais objetivo / Marcar resolvido
3. **Contexto da venda** (direita): foto + título + status do envio + dados do comprador + **base de conhecimento editável do produto** (manual, problemas comuns, garantia, política de troca, observações)

**Como funciona o pipeline**:
1. ML envia webhook \`POST /ml/webhook\` (topic=messages) em segundos
2. Backend baixa o pack + mensagens via API ML
3. Pra cada mensagem do COMPRADOR:
   - **Classificação Haiku** (15 intents: dúvida, entrega, atraso, NF, defeito, irritado, ameaça reclamação, etc.) + sentimento + urgência + risco
   - **Sugestão Sonnet 4.6** ≤ 350 chars (limite ML), com regenerate-once se estourar; regras duras (nunca pedir telefone, nunca prometer prazo, etc.)
4. Calcula SLA em horas úteis (08-18 SP, seg-sex)
5. Emite Socket.IO real-time → UI atualiza sem refresh

**SLA semáforo** (horas úteis desde a msg do comprador sem resposta):
- 🟢 Verde: <4h | 🟡 Amarelo: 4-12h | 🟠 Laranja: 12-20h | 🔴 Vermelho: 20-24h
- ⚫ Crítico: ≥24h (limite SLA do ML — perde direito de pedir exclusão de reclamação)

**Boas práticas**:
- Mantenha **KB do produto** atualizada — IA usa pra responder com precisão
- Mensagem com risk='crítico' dispara alerta automático no Intelligence Hub (gestor recebe WhatsApp)

**Configuração necessária**: webhook ML no devcenter (callback \`https://api.eclick.app.br/ml/webhook\` + topic \`messages\` ativo).`,
    tags: ['atendimento', 'ml', 'pos-venda', 'inbox', 'sla', 'webhook', 'ia'],
  },
  {
    routes:   ['/dashboard/inteligencia/ml'],
    category: 'inteligencia',
    title:    'Intelligence Hub — Mercado Livre (reputação + claims + exclusão)',
    content: `**Painel de monitoramento ML** (entregue 2026-05-07 — MVP 2 do Pós-venda).

**O que cobre**: visão de NEGÓCIO do ML — reputação, reclamações abertas, candidatos a exclusão de reclamação. Diferente de \`/dashboard/ml-postsale\` (que é a inbox operacional mensagem-a-mensagem).

**3 áreas**:

1. **Reputação ML** (header com sparklines 30 dias):
   - Nível atual (5_green / 4_light_green / 3_yellow / 2_orange / 1_red)
   - 3 KPIs: % Reclamações | % Cancelamentos | % Atraso de envio
   - Cada KPI tem threshold visual (linha amarela=warning, linha vermelha=crítico)
   - Trend arrow comparando último vs antepenúltimo
   - **Snapshot diário 6h SP** (cron) — primeiros dados aparecem amanhã às 6h ou disparáveis manualmente

2. **Reclamações abertas** (esquerda inferior):
   - Lista de claims do ML com badge "MEDIAÇÃO" quando aplicável
   - Click leva direto pra inbox (\`/dashboard/ml-postsale\`)

3. **Candidatos a exclusão de reclamação** (direita inferior — IA híbrida):
   - **Detecção regex + LLM**: 16 patterns PT-BR ("abri por engano", "produto chegou", "não fui eu", "pode cancelar a reclamação") → Haiku qualifica → persiste se confidence ≥ medium
   - **Confidence badge**: alta/média/baixa
   - **Texto sugerido pela IA** pra enviar ao ML solicitando exclusão (cyan box)
   - Botões:
     - **Confirmar e copiar texto** — copia pro clipboard + marca como solicitado
     - **Regenerar texto** — pede nova versão à IA
     - **Falso positivo** — descarta candidato

**Alertas automáticos** (Intelligence Hub gera WhatsApp pro gestor cadastrado):
- 🚨 Reclamação aberta (severity=crítico, immediate)
- 🚨 Mediação iniciada (crítico)
- 📦 Pedido atrasado ≥3d (crítico) ou ≥1d (warning) — cron horário
- 📉 Reputação ML em risco — cruzar threshold (warning ou crítico)
- 💬 Mensagem crítica — risk='crítico' detectado no MVP 1
- 🔓 Candidato a exclusão (warning ou crítico conforme confidence)

**Submissão da exclusão ao ML**: no MVP 2 a IA SÓ gera o texto + copia pro clipboard. Envio é manual via painel ML (cole o texto na mediação).`,
    tags: ['inteligencia', 'ml', 'reputacao', 'claims', 'exclusao', 'ia'],
  },
  {
    routes:   [
      '/dashboard/inteligencia',
      '/dashboard/inteligencia/alertas',
      '/dashboard/inteligencia/gestores',
      '/dashboard/inteligencia/relatorios',
      '/dashboard/inteligencia/configuracoes',
    ],
    category: 'inteligencia',
    title:    'Intelligence Hub — gestores, alertas, regras',
    content: `**Sistema de monitoramento ativo + alertas multicanal**. Em prod desde 2026-05-04, vertical ML adicionada em 2026-05-07.

**5 analyzers automáticos** geram sinais (\`alert_signals\`):
- **estoque** (cada 15min) — ruptura iminente, estoque alto
- **compras** — fornecedor problemático, falta crítica
- **margem** — margem caindo abaixo do alvo
- **ads** — campanha sangrando, ROAS ruim
- **ml** (vertical NOVA — MVP 2) — claim, mediação, atraso, reputação, mensagem crítica, candidato exclusão

**Fluxo de um sinal**:
1. Analyzer detecta evento → grava em \`alert_signals\` (severity + score 0-100)
2. **AlertEngine** lê \`alert_routing_rules\` → decide quais gestores recebem (por department + analyzer + categories + min_score)
3. **AlertDeliveries** rastreia entrega (whatsapp / email / push / dashboard)
4. **WhatsApp** vai via Baileys quando gestor está \`verified\`

**Telas do hub**:
- **\`/inteligencia/alertas\`** — feed de alertas dos analyzers, ack/resolve, filtros por severity/analyzer
- **\`/inteligencia/gestores\`** — CRUD de pessoas que recebem alertas (nome + WhatsApp + departamento). Cada gestor precisa **verificar phone** clicando "Verify-phone" → recebe código WA → confirma. Sem verify, alertas WA não chegam.
- **\`/inteligencia/ml\`** — painel específico ML (reputação + claims + candidatos exclusão)
- **\`/inteligencia/relatorios\`** — KPIs históricos
- **\`/inteligencia/configuracoes\`** — toggles globais (analyzers on/off, quiet hours, max alerts/dia, digest schedule)

**Real-time**: todo signal novo emite Socket.IO \`intelligence:alert\` → componente \`AlertToastListener\` (global em todas telas do dashboard) mostra toast moderno no canto sup direito (abaixo do header).

**Toasts redesign 2026-05-08** — design futurista, menos invasivo:
- **Glassmorphism**: backdrop-blur + bg semi-transparente + glow colorido por severity
- **Compact mode default** (340px × ~60px) — só severity + categoria + summary truncado
- **Hover expande** mostrando suggestion completa, lista de alertas agrupados, link "Ver no painel"
- **Smart grouping**: alertas mesma categoria+severity em janela 60s viram 1 card com badge "+N"
- **Auto-dismiss em 8s** (era 30s) com progress bar fina embaixo. Pausa ao hover.
- **Critical**: ring sutilmente pulsante, sem auto-dismiss
- **Stack max 3** (novos empurram velhos pra fora). Cards atrás levemente menores (escala -1.5% por nível) — efeito de profundidade.
- **Slide+fade entry** (320ms cubic-bezier elastic)
- Sem invasão do conteúdo: posição top-right discreta, dismiss icon só aparece em hover

Severities: critical (vermelho ef4444) > warning (âmbar f59e0b) > info (cyan 06b6d4).

**Pra ativar a vertical ML pra um lojista**:
1. Configurar webhook ML no devcenter (URL backend + topic \`messages\`/\`questions\`/\`claims\`)
2. Cadastrar **manager** em \`/inteligencia/gestores\` com phone do dono → verify-phone
3. (Opcional) editar routing rule \`atendimento + analyzer=ml\` se quiser custom department
4. Esperar primeiro evento ML (ou disparar manualmente)`,
    tags: ['inteligencia', 'hub', 'alertas', 'gestores', 'whatsapp', 'analyzers', 'ml'],
  },
  {
    routes:   ['/dashboard/configuracoes/integracoes', '/dashboard/configuracoes'],
    category: 'configuracoes',
    title:    'Webhook Mercado Livre — configuração obrigatória',
    content: `**Pra módulos ML funcionarem em real-time** (Pós-venda IA, Intelligence Hub ML, Perguntas IA), o webhook precisa estar registrado no devcenter ML.

**Passo a passo** (1 minuto):

1. Acessa https://developers.mercadolivre.com.br/devcenter
2. Suas aplicações → app do e-Click
3. Procura aba **"Notificações"** (ou "Configuração de notificações")
4. Em **URL de retornos de chamada de notificação**:
   \`\`\`
   https://api.eclick.app.br/ml/webhook
   \`\`\`
   ⚠️ \`api.\`eclick.app.br (backend), NÃO eclick.app.br (frontend) — são URLs diferentes
5. Em **Tópicos**, marca os 3:
   - \`messages\` (pós-venda — MVP 1)
   - \`questions\` (perguntas pré-venda)
   - \`claims\` (reclamações — MVP 2)
6. Salvar

**Outra URL no painel ML é a OAuth callback** (\`eclick.app.br/dashboard/integracoes/ml/callback\`) — essa fica como está, é diferente do webhook.

**Validar que funcionou**:
- Endpoint backend retorna 200 em \`POST /ml/webhook\`
- Quando uma mensagem nova chega no ML, em <30s aparece em \`ml_conversations\` no Supabase
- UI \`/dashboard/ml-postsale\` mostra real-time

**Sem webhook configurado**: as telas ficam vazias mesmo com mensagens existentes no ML (módulo só captura A PARTIR do momento que ativa — não faz backfill automático).`,
    tags: ['configuracoes', 'integracoes', 'webhook', 'ml', 'setup'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// ML Campaign Center IA (F8) — adesão a campanhas ML com decisão IA
// ════════════════════════════════════════════════════════════════════════

const ML_CAMPAIGNS_ENTRIES: KbEntry[] = [
  {
    routes:   [
      '/dashboard/ml-campaigns',
      '/dashboard/ml-campaigns/list',
      '/dashboard/ml-campaigns/[id]',
    ],
    category: 'campaigns',
    title:    'Campaign Center IA — fluxo de adesão a campanhas ML',
    content: `**Painel de campanhas ML elegíveis com decisão IA por item.** Substitui o "deal participation" manual da plataforma do ML.

**Fluxo correto pra participar de uma campanha (4 passos):**

1. **Sync** (\`POST /ml-campaigns/sync\`): traz lista de campanhas elegíveis + items em cada (status \`candidate\`/\`pending\`/\`started\`).
2. **Gerar Recomendações IA** (botão "Gerar Recomendações IA (X)" na página da campanha): decision engine analisa cada candidato — margem de contribuição, subsídio MELI (\`meli_percentage\`), preço sugerido vs mínimo aceito — e cria uma recommendation com classificação \`recommended\`/\`not_recommended\`/\`needs_review\` + reason + opportunity_score.
3. **Aprovar/Editar** (em \`/dashboard/ml-campaigns/recommendations\`): você revisa cada recomendação, edita preço/quantidade se quiser.
4. **Aplicar** (\`POST /ml-campaigns/apply/single\` ou \`/apply/batch\`): submete pra ML API; item passa de candidate → started.

**Por que NÃO existe botão "Aderir" direto:**
- ML não aceita adesão sem preço promocional definido
- IA precisa validar margem mínima (config \`min_margin_pct\`) — sem isso você poderia entrar em campanha que dá prejuízo
- Subsídio MELI vem por item, não por campanha — IA combina os 2

**Status de item:**
- \`candidate\`: ML te convidou, ainda não aderiu
- \`pending\`: aderiu mas campanha não começou
- \`started\`: ATIVO, vendendo no preço promocional
- \`finished\`: campanha encerrou

**Health flag INCOMPLETE:**
Item sem custo cadastrado (catálogo) ou sem preço mínimo aceito do ML — decision engine não consegue julgar margem, marca como needs_review.

**Sair de campanha**: botão "Sair" por linha em items \`started\` → \`POST /leave/single\` → ML remove a oferta, item volta a candidate.

**Subsídio "ML reduz X%"**: ML banca uma parte do desconto. Bom indicador — quanto maior o \`meli_percentage\`, menor seu sacrifício de margem.`,
    tags: ['ml-campaigns', 'campaigns', 'deal', 'price-discount', 'subsidio'],
  },
  {
    routes:   ['/dashboard/ml-campaigns/recommendations', '/dashboard/ml-campaigns/recommendations/[id]'],
    category: 'campaigns',
    title:    'Recomendações IA de campanha — aprovar/rejeitar',
    content: `**Lista de sugestões geradas pela IA pra cada item candidato.**

**Classificação:**
- 🟢 \`recommended\`: margem positiva + subsídio bom + sem warnings — aderir é seguro
- 🟡 \`needs_review\`: dado incompleto ou margem apertada — você decide
- 🔴 \`not_recommended\`: margem negativa ou abaixo do mínimo configurado

**Opportunity score (0-100):** combina subsídio + visibilidade da campanha + lift estimado de conversão.

**Filtros**: por classification, status (pending/approved/rejected/applied), score mínimo, campaign_id.

**Editar antes de aprovar**: pode mudar \`price\` ou \`quantity\` — fica registrado no audit_log.

**Após aprovar**: vai pro batch apply em \`/dashboard/ml-campaigns/apply\` — **MAS atenção ao soft gate** (próxima entry).`,
    tags: ['ml-campaigns', 'recommendations', 'ai-decision'],
  },
  {
    routes:   ['/dashboard/ml-campaigns/alerts'],
    category: 'campaigns',
    title:    'Alertas WhatsApp de campanha (M2 + M3)',
    content: `**Cron 9h SP** varre todas as configs com \`whatsapp_alerts_enabled=true\` e dispara 3 tipos de alerta via Active Bridge (\`notifyLojista\`):

**1. Deadline warning (escala D-X..D-0):**
- Campanhas com \`deadline_date\` em \`[hoje, hoje + deadline_alert_days_before]\`
- Severity: D-2+ medium · D-1 high · D-0 critical (se \`escalate_alerts=true\`)
- **SKIP se 0 items pendentes** (operador já agiu = não notificar)
- Dedup: 1 alerta por (campanha × dia × severity)

**2. Subsidy opportunity (proativo):**
- Campanhas vivas com \`avg_meli_subsidy_pct > auto_alert_when_subsidy_above_pct\` E \`candidate_count > 0\`
- 1× lifetime por campanha (não enche a paciência)

**3. Manager queue digest:**
- Se gestor tem N+ \`pending_manager_approval\` e tem \`manager_whatsapp_phone\` → manda 1×/dia
- Inclui aviso se algum operador acumulou >\`audit_attempts_threshold\` tentativas em 30d

**M3 — Agrupamento:**
- Se mesmo \`recipient_phone\` recebeu **5+ alertas hoje**, sistema manda **1 digest** "Você tem N pendências" e **bloqueia novos alertas até amanhã**
- Evita queimar o canal WhatsApp com spam

**Tudo registrado em \`ml_campaign_alert_log\`:** dedup_key + status (sent/skipped_dedup/skipped_no_action/failed) + bridge_response + skip_reason. Audit completo.

**Endpoint manual** \`POST /ml-campaigns/alerts/run\` dispara varredura sem aguardar cron — útil pra testar config (\`/alerts\` tem botão "Rodar agora").`,
    tags: ['ml-campaigns', 'alerts', 'whatsapp', 'cron', 'active-bridge'],
  },
  {
    routes:   ['/dashboard/ml-campaigns/manager-queue', '/dashboard/ml-campaigns/config'],
    category: 'campaigns',
    title:    'Soft gate de margem mínima + fila do gestor',
    content: `**Proteção operacional contra aprovações abaixo do mínimo de margem.** (M1, sprint 2026-05-08)

**Como funciona:**
1. Operador clica "Aprovar" numa recomendação
2. Sistema calcula M.C.% final (preço escolhido vs cost_breakdown — inclui custo + imposto + comissão ML + frete + embalagem + operacional − subsídio MELI)
3. Threshold = \`per_campaign_type_overrides[type] ?? min_approval_margin_pct\` (default 10%)
4. Se margem ≥ threshold → status \`approved\`, segue pro K3 apply
5. Se margem < threshold → status \`pending_manager_approval\`, vai pra **fila do gestor**

**Fila do gestor** (\`/dashboard/ml-campaigns/manager-queue\`):
- Lista todas recomendações pending_manager_approval
- Cada card mostra: produto, margem tentada vs threshold, motivo da IA, warnings
- Gestor clica "Liberar override" (status → \`manager_approved\`, segue pra apply) OU "Rejeitar" (status → \`rejected_by_manager\`)
- Modal pede motivo opcional pro audit log

**Audit log** (\`ml_campaign_approval_attempts\`):
- Toda tentativa abaixo do gate vira uma row
- Outcome: \`sent_to_manager\` → \`manager_approved\` | \`manager_rejected\`
- Se um operador acumula > \`audit_attempts_threshold\` (default 5) tentativas em 30d, o sistema avisa "padrão suspeito" pro gestor decidir

**Override por tipo de campanha** (\`per_campaign_type_overrides\`):
- DEAL com subsídio aceita 8% (porque ML banca parte) mas PRICE_DISCOUNT puro exige 15%
- JSON \`{ "DEAL": 8, "PRICE_DISCOUNT": 15 }\` no config

**Configuração** (\`/dashboard/ml-campaigns/config\`):
- \`min_approval_margin_pct\` — limite global
- \`per_campaign_type_overrides\` — override por tipo
- \`audit_attempts_threshold\` — quantas tentativas suspeitas trigam alerta
- \`manager_user_id\` / \`manager_whatsapp_phone\` — quem vê fila + recebe alertas
- \`assignee_user_id\` / \`notification_phone\` — operador responsável (recebe deadline alerts)

**Valor real:** sem soft gate, operador apressado pode aprovar 30 itens com -2% de margem em 5 minutos. Com gate + audit, gestor enxerga o problema antes do prejuízo virar permanente.`,
    tags: ['ml-campaigns', 'soft-gate', 'manager', 'audit', 'margin'],
  },
  {
    routes:   ['/dashboard/ml-campaigns/apply', '/dashboard/ml-campaigns/apply/[jobId]'],
    category: 'campaigns',
    title:    'Apply Wizard — aplicar recomendações aprovadas em lote',
    content: `**Wizard de aplicação em lote** depois que aprovou várias recomendações.

**Modos:**
- \`safe\`: aplica só as recomendações verdes; pula amarelas/vermelhas mesmo se aprovadas
- \`best_effort\`: tenta tudo aprovado, registra falhas

**Job pattern**: cria 1 \`ml_campaign_apply_jobs\` row, processa em background, tracking via \`/apply/jobs/:id\` (success_count, failure_count, errors[]).

**Re-tentativa**: se ML API der 429, backoff + retry automático. Se der erro permanente (item pausado, preço inválido), registra no audit_log e segue.`,
    tags: ['ml-campaigns', 'apply', 'batch'],
  },
  {
    routes:   [
      '/dashboard/ml-campaigns/analytics',
      '/dashboard/ml-campaigns/analytics/[campaignId]',
      '/dashboard/ml-campaigns/health',
      '/dashboard/ml-campaigns/audit',
    ],
    category: 'campaigns',
    title:    'Analytics + Health + Audit (Camada 4)',
    content: `**Analytics post-mortem** (\`/analytics\`): por campanha encerrada — o que vendeu, ROI estimado, taxa de conversão, qual classificação IA acertou mais.

**Health** (\`/health\`): items "INCOMPLETE" — falta custo, falta margem mínima, falta preço base. Lista pra você corrigir no catálogo e desbloquear o decision engine.

**Audit log** (\`/audit\`): tudo que aconteceu — quem aprovou o quê, quando, com qual preço. Compliance + debugging.`,
    tags: ['ml-campaigns', 'analytics', 'audit', 'health'],
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

**Especialista ML Ads** (botão flutuante DEDICADO desta tela, canto inf direito):
- IA com contexto rico das campanhas/ROAS/SKUs em tempo real
- Empty state com 12 chips de sugestão fluindo (carrossel animado)
- Histórico de conversas persistente (\`/ads/inteligencia/conversas\`)
- Perguntas tipo: "Qual pausar?", "Onde perco dinheiro?", "Tenho estoque pra dobrar budget?", "ACOS médio das campanhas"

**O copiloto flutuante GENÉRICO (Cmd/Ctrl+K) fica ESCONDIDO nesta rota** porque a IA especializada de Ads cobre o domínio melhor (com dados reais das campanhas). Cmd/Ctrl+K continua abrindo o copiloto via atalho se quiser usar mesmo assim.`,
    tags: ['ads', 'ml', 'roas', 'ia-especializada'],
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
// Copiloto da Loja (full-page) + UX recente
// ════════════════════════════════════════════════════════════════════════

const COPILOT_PAGE_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/store-copilot'],
    category: 'copiloto',
    title:    'Copiloto da Loja — comandos em linguagem natural',
    content: `**Tela de copiloto full-page** que executa ações via tools (não só responde — faz).

**Empty state animado** (sem turns ainda):
- Brain ícone centralizado + "Como posso ajudar?"
- 3 fileiras de chips fluindo em direções alternadas (carrossel)
- Hover pausa todas as fileiras simultaneamente
- 14 sugestões cobrindo: kits, coleções, preços, ações pendentes, top produtos,
  vendas 7d, estoque baixo, otimizar títulos, clientes recorrentes, capas de
  campanha, tendência, perguntas ML, descrição IA, calendário ideal

**Modo conversa** (após 1ª mensagem):
- Header padrão volta com Brain ícone
- Lista de turns scrollável
- Cada turn pode ter intent (ex: \`create_kits\`), params, requires_confirmation
- Confirmação explícita antes de executar ações destrutivas
- Card verde "Executado" com JSON de retorno

**Diferença vs Copiloto flutuante** (sininho):
- **Flutuante** (este aqui) = Q&A sobre uso do sistema, KB de docs
- **Copiloto da Loja** = ações reais (criar kit, gerar coleção, analisar preços)

**Atalho**: \`Cmd/Ctrl+K\` em qualquer tela abre o flutuante.`,
    tags: ['copiloto', 'store-copilot', 'tools'],
  },
  {
    routes:   ['/dashboard/*'], // tema funciona em todas as rotas
    category: 'config',
    title:    'Tema claro / escuro',
    content: `**Toggle Sun/Moon no Header** (canto superior direito, entre Buscar e sino).

- Click muda entre claro e escuro instantaneamente
- Persiste em localStorage (chave \`eclick-theme\`)
- Inline script aplica no \`<head>\` antes do React hydratar — sem flash
- Atalho: nenhum (clicar mesmo)

**Cobertura atual**: chrome do app reage (Header, Sidebar, body bg, scrollbar).
Conteúdo das páginas internas ainda é dark (cores hardcoded em centenas de
componentes). Migração incremental — \`/pedidos\` é prioridade (mais usado).

**Ícone indica destino, não estado atual**:
- Sun visível = você está no escuro, click vai pra claro
- Moon visível = você está no claro, click vai pra escuro

Padrão consagrado VS Code/GitHub.`,
    tags: ['tema', 'theme', 'dark', 'light', 'config'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// Multi-conta ML (cross-conta) — arquitetura transversal
// ════════════════════════════════════════════════════════════════════════

const MULTI_ACCOUNT_ENTRIES: KbEntry[] = [
  {
    routes:   [
      '/dashboard/configuracoes/integracoes',
      '/dashboard/integracoes',
      '/dashboard/pedidos',
      '/dashboard/atendimento/perguntas',
    ],
    category: 'multi-conta',
    title:    'Multi-conta Mercado Livre — fan-out cross-conta',
    content: `**Org pode conectar várias contas ML.** Cada conexão tem seu próprio token, seller_id e nickname.

**Fan-out** = quando o backend não sabe a qual conta um recurso pertence, ele tenta TODOS os tokens da org até um responder. Ativo em:

- **Lista de pedidos** (thumbnails + detalhe enriquecido)
- **Criar produto a partir de listagem** (\`createFromListing\`)
- **Refetch billing/CPF** (botão 🔄 no card do comprador)
- **Cron horário de billing** (\`MlBillingFetcherService.fetchBatch\`)

**Por que importa**: ML retorna \`401/403\` quando você tenta acessar pedido/anúncio de outra conta com token errado. Sem fan-out, recursos cross-conta sumiam ou apagavam dados bons (CPF wiped por refetch falho — bug já corrigido).

**Trocador de conta** no header da tela (\`AccountSelector\`):
- "Todas" agrega
- Por nickname filtra resultados pra aquela conta

**Limitação atual**: o worker de ingestão (\`OrdersIngestionService.ingestDateRange\`) ainda usa um único token por execução. Pedidos cross-conta importados pela 1ª vez ainda sem CPF até user clicar 🔄. Refactor maior pendente — fan-out por seller_id no nível de ingestão.

**Defensive guards** garantem que CPF/phone bom NUNCA é sobrescrito por null em re-fetches falhos (worker e refetchOne ambos fazem merge: existing data é fallback do que o ML novo não devolveu).`,
    tags: ['multi-conta', 'fan-out', 'cross-conta', 'cpf', 'token'],
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

📊 **Cards Faturamento + Lucro Estimado** (linha 2):
- Período exibido (Hoje / 7d / 30d / Mês atual) controla TODOS os cards
- **Comparação com período anterior é time-clamped** — pra HOJE, mostra ontem ATÉ O MESMO HORÁRIO (não o dia inteiro de ontem). Pra mês, compara mesmo dia/hora do mês passado. Apples-to-apples sempre.
- **Meta do período** abaixo do comparativo: barra de progresso com % atingido. Lê do módulo /dashboard/metas (tipo='revenue' mensal vira meta diária ÷ dias_no_mês). Sem meta configurada → "Definir meta →".
- Cores da barra: <50% red, 50-75% amber, 75-100% cyan/verde, ≥100% verde brilhante.

Use o copiloto flutuante (canto inferior direito) pra dúvidas sobre qualquer tela.`,
    tags: ['general', 'dashboard', 'navigation', 'metas', 'kpis'],
  },
]

// Catch-all entries — adicionadas POR ÚLTIMO no KB pra não drenar o
// budget de 3000 chars do excerpt. Entries route-específicas vencem.
const CATCHALL_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard', '/dashboard/[...rest]'],
    category: 'general',
    title:    'Novidades recentes do sistema',
    content: `**Capacidades novas que talvez você não conheça** (atualizado 2026-05):

🎨 **Tema claro/escuro**
- Botão Sun/Moon no Header (canto sup direito)
- Persiste por device. Cobertura inicial: chrome do app

📦 **Pedidos enriquecidos** (\`/dashboard/pedidos\`)
- Card mostra: thumbnail real, "X disponíveis após esta venda", Carrinho# (pack_id),
  Quem recebe, Rastreio, Tipo entrega, badges Cupom/Publicidade
- Lista carrega instantânea do DB; 1ª expansão do card faz enrichment ML (~3s)
- Próximas visitas instantâneas — dados persistem

🛒 **Bulk Excel CMV/Imposto**
- Em \`/dashboard/produtos\`, botão "Subir planilha"
- Aceita .xlsx/.csv com colunas SKU, PREÇO (CMV), IMPOSTO (%)
- Atualiza catálogo em massa (~50 produtos/segundo)

🔗 **"Vincular Produto"** (popup nos cards de pedido)
- Aparece quando há match de SKU entre listing ML e catálogo
- Permite vincular múltiplos anúncios ao mesmo produto em batch
- Habilita CMV + Imposto naquele pedido + futuros do mesmo SKU

🔄 **Multi-conta ML com fan-out**
- Org pode ter várias contas ML conectadas
- Sistema varre todos os tokens automaticamente pra resolver thumbnails,
  detalhe de pedido, criar produto a partir de listing
- Botão 🔄 no card do comprador refaz busca de CPF cross-conta

🧠 **Copiloto da Loja** (\`/dashboard/store-copilot\`)
- Chat full-page que EXECUTA ações via tools
- Empty state com carrossel de 14 sugestões fluindo
- Diferente deste copiloto flutuante (que só ensina)

⚡ **Atalho \`Cmd/Ctrl+K\`** abre este copiloto flutuante em qualquer tela.

Pergunta "como funciona X?" pra qualquer feature acima ou navegue pra
tela específica e abra o copiloto novamente — a KB tem detalhes
contextuais por rota.`,
    tags: ['novidades', 'changelog', 'features', 'tema', 'pedidos', 'multi-conta', 'copiloto'],
  },
  {
    routes:   ['/dashboard', '/dashboard/[...rest]'],
    category: 'general',
    title:    'Como pedir ajuda neste copiloto',
    content: `**Sou o copiloto/professor do e-Click.** Posso explicar features, melhores práticas e como extrair valor.

**Atalhos**:
- \`Cmd/Ctrl+K\` em qualquer tela me abre/fecha
- Ou clique no botão flutuante (cyan, canto inf direito)

**Tipos de pergunta que respondo bem**:
- "O que essa tela faz?" / "Como uso X?"
- "Qual a diferença entre A e B?"
- "Quais melhores práticas pra Y?"
- "Onde mudo a configuração de Z?"
- "O que mudou recentemente?"

**O que NÃO faço** (esse é o **Copiloto da Loja** em \`/dashboard/store-copilot\`):
- Executar ações (criar produto, gerar conteúdo, atualizar preço)
- Acessar dados em tempo real (vendas hoje, KPIs específicos)

**Feedback**: thumbs up/down depois da minha resposta — isso treina prompts/KB futuros.

**Limpar conversa**: ícone de lixeira no header.`,
    tags: ['ajuda', 'help', 'meta', 'copiloto'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// Dropship Center IA (F9) — completo (12 sprints)
// ════════════════════════════════════════════════════════════════════════

const DROPSHIP_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/dropship'],
    category: 'dropship',
    title:    'Dropship Center — visão geral',
    content: `**Central do dropship.** Operação completa: parceiros, catálogo, identificação automática de pedidos, OCs diárias, portal do parceiro, devoluções, créditos, disputas, score, divergências, copiloto IA.

**Princípio**: Vendeu → Despachou → Conferiu → OC do dia → Aprovou → Pagou → Devolução abate.

**KPIs no dashboard** (\`/dashboard/dropship\`): Parceiros ativos, SKUs dropship, Despachados hoje, Receita hoje, CMV, Margem, Em Hold, Sem Estoque. Banner de alerta se há pedidos em hold ou SKUs sem estoque do parceiro.

**Cron jobs ativos**:
- \`dropship-identify-orders\` @5min — busca orders novos das contas vinculadas a parceiros e cria \`dropship_order_identifications\`
- \`dropship-oc-generation\` @22h diário — agrupa identifications elegíveis por (supplier, marketplace, conta) e gera OCs
- \`dropship-monthly-scores\` @00:30 dia 1 — calcula score do mês anterior dos parceiros ativos
- \`dropship-divergence-scan\` @02h — detecta 3 tipos de divergência (atraso envio, sem mapeamento, preço<custo)`,
    tags: ['dropship', 'overview'],
  },
  {
    routes:   ['/dashboard/dropship/partners', '/dashboard/dropship/partners/new', '/dashboard/dropship/partners/[id]'],
    category: 'dropship',
    title:    'Parceiros dropship — cadastro e configuração',
    content: `**Cadastro do parceiro** (\`/dashboard/dropship/partners/new\`):
Form único com 6 seções (Identificação / Contato / Notificação / Janela operacional / Estratégia / Pagamento). Backend faz 2 inserts atômicos (\`suppliers\` + \`supplier_dropship_profiles\`).

**Campos críticos**:
- \`notification_email\` (obrigatório) — pra onde a OC é enviada
- \`cutoff_time\` (default 14h) — até quando parceiro processa pedido do dia
- \`integration_type\`: manual / spreadsheet / api / csv_email / sftp / erp_bling / erp_tiny / erp_omie
- \`cost_strategy\` (default \`current_table\`) — custo do momento da OC, não do momento da venda
- \`return_credit_strategy\` (default \`next_oc\`) — devolução vira crédito na próxima OC
- Janela OC: \`oc_preview_open_time\` 12h, \`oc_review_cutoff_time\` 21h, \`oc_generation_time\` 22h

**Status**: active / paused (com paused_reason) / inactive (arquivado) / pending_setup. Soft-delete via DELETE = status='inactive'.

**Detalhe do parceiro** mostra KPIs (status / SKUs ativos / pedidos 30d / a pagar) + 3 botões secundários no header (Catálogo / Logs sync / Arquivar).

**Saldo de créditos**: badge na lista mostra valor pendente por parceiro (de devoluções aprovadas que viraram \`dropship_partner_credits\`).`,
    tags: ['dropship', 'partners', 'cadastro'],
  },
  {
    routes:   ['/dashboard/dropship/account-suppliers'],
    category: 'dropship',
    title:    'Vínculo conta de marketplace ↔ parceiro',
    content: `**Mapeia "qual parceiro despacha pelos pedidos desta conta de marketplace".**

Quando entra um pedido novo no Mercado Livre/Shopee/Amazon, o cron @5min:
1. Lê \`order.seller_id\` (ML) ou \`shop_id\` (Shopee) ou \`amazon_seller_id\`
2. Busca em \`seller_account_suppliers\` qual supplier está vinculado a essa conta
3. Resolve \`product_id\` via SKU se products.product_id é null
4. Valida \`products.supply_type='dropship'\`
5. Cria \`dropship_order_identifications\` com supplier_id resolvido + snapshot de custo + margem estimada

**Hoje (v1)**: 1 conta = 1 supplier default (\`is_default=true\`). **v2 (futuro)**: regras dinâmicas por SKU/região/preço.

**Pedido sem mapeamento** (account não vinculada): o cron NÃO cria identification. O pedido é tratado como NÃO-dropship.

**Pedido com SKU sem supplier_product**: cria identification status='on_hold' com hold_reason explicativo. Aparece na divergência \`missing_partner_product\`.

**Desvincular**: setar \`active_until\` em vez de DELETE — preserva histórico.`,
    tags: ['dropship', 'marketplace', 'mapping'],
  },
  {
    routes:   ['/dashboard/dropship/partners/[id]/products', '/dashboard/dropship/partners/[id]/import'],
    category: 'dropship',
    title:    'Catálogo do parceiro + importação',
    content: `**Catálogo dropship** vive em \`supplier_products\` (mesma tabela do cadastro genérico) com 10 colunas extras dropship: \`partner_stock\`, \`partner_reserved\`, \`partner_available\` (generated), \`master_sku\`, \`partner_packaging_cost\`, \`partner_handling_cost\`, \`last_*_at\`, \`dropship_status\`.

**Adicionar produto**: modal lateral com autocomplete de products (search via supabase.from('products').or(name.ilike,sku.ilike) com debounce 250ms) + form de cost/packaging/handling/stock/lead/moq.

**Editar produto**: modal mostra cost decomposto. Mudança de custo pede motivo + cria snapshot em \`supplier_cost_history\` (auditoria, NÃO afeta cálculo retroativo).

**Histórico de custos**: clique no ícone History → modal timeline de \`supplier_cost_history\` com snapshot vigente destacado em cyan.

**Importação em massa** (\`/import\`): wizard 3-step:
1. Upload XLSX/CSV com colunas: supplier_sku (req), unit_cost (req), master_sku, product_sku, packaging_cost, handling_cost, stock, lead_time_days, moq. Aliases case-insensitive aceitos (PT-BR + EN).
2. Preview com KPIs (válidas/erro) + tabela 30 primeiras linhas marcando erros.
3. POST /dropship/partner-products/bulk-import. Upsert por (supplier, product). Detecta cost change >5% e marca em significant_cost_changes. Resultado mostra criados/atualizados/falhas + link pro sync log.

**Custo vigente vs histórico**: OC gerada às 22h usa \`supplier_products.unit_cost\` ATUAL (current_table strategy). cost_history só audita.`,
    tags: ['dropship', 'catalog', 'sync', 'planilha', 'import'],
  },
  {
    routes:   ['/dashboard/dropship/orders', '/dashboard/dropship/orders/today'],
    category: 'dropship',
    title:    'Pedidos dropship — identificação e gestão',
    content: `**\`/dashboard/dropship/orders\`** lista pedidos identificados como dropship. Tabela com pedido ID + marketplace pill + parceiro + produto (com thumb) + qtd/preço/custo/margem (verde se >0, red se <0) + status pill + ações.

**Status workflow** (14 estados): \`identified\` → \`shipped\` → \`shipped_confirmed\` → \`eligible_for_oc\` → \`in_oc_*\` → \`in_payable\` → \`paid\`. Atalhos: \`on_hold\` (com hold_reason) / \`returned\` / \`cancelled\`.

**Ações inline**: Pause (suspende com reason) / Play (libera de hold). Botão "Forçar identificação" no header dispara o cron manualmente.

**\`/dashboard/dropship/orders/today\`** mostra agregação do dia:
- 5 KPIs gerais (Pedidos / Unidades / Receita / CMV / Margem com cor semântica)
- Cards por parceiro (orders count + receita/CMV/margem + % margem)
- Tabela detalhada cronológica do dia

**Margem estimada**: salva snapshot em identification (cost_at_sale + sale_price + estimated_margin). Pra cálculo final usa \`supplier_products.unit_cost\` vigente quando OC é gerada.`,
    tags: ['dropship', 'orders', 'pedidos'],
  },
  {
    routes:   ['/dashboard/dropship/oc', '/dashboard/dropship/oc/preview', '/dashboard/dropship/oc/[id]'],
    category: 'dropship',
    title:    'Ordens de Compra (OC) Dropship — geração diária + portal',
    content: `**OC dropship ≠ purchase_order de importação**. OC dropship é diária (cron @22h), 1 por (supplier, marketplace, conta), numeração \`DOC-YYYY-MM-DD-SUPPLIER_SLUG-NNN\`.

**Workflow status**: draft → generated → sent → viewed → approved → in_payable → paid. Pode também: rejected / cancelled / on_hold.

**\`/dashboard/dropship/oc\`** — lista com 4 KPIs (Total / Geradas-sem-envio / Aguard. aprovação / Valor líquido total). CutoffBanner no topo mostra fase atual:
- 00:00-12:00 cinza "Aguardando prévia abrir"
- 12:00-21:00 cyan "Prévia aberta"
- 21:00-22:00 amber "Prévia trancada"
- 22:00-00:00 verde "OCs do dia geradas"
Countdown ao próximo evento (re-render @1min).

**\`/oc/preview\`** — agregação live (calcula on-the-fly, não persiste): mostra quais OCs SERIAM geradas se rodasse cron agora, agrupadas por (supplier, marketplace) com items_count + units + gross_total estimado. Auto-refresh @60s.

**\`/oc/[id]\`** — detalhe rico:
- Status pill grande + datas (referência/vencimento)
- 4 KPIs (Itens/Unidades/Bruto/Líquido)
- Breakdown de créditos (5 tipos: return/cancellation/warranty/divergence/other) quando total_credits>0
- Dados do parceiro denormalizados (CNPJ/contato/payment_terms)
- Tabela de items com thumb + custo decomposto + status item
- Botões: **Excel** (gera client-side via lib xlsx, 2 abas), **Enviar Parceiro** (dispara e-mail+WA com link portal), **Cancelar OC** (com prompt motivo — reverte items pra eligible_for_oc).

**Portal do parceiro** (\`/portal/oc/[token]\`, **PÚBLICO sem auth**):
- Token 64 chars hex aleatório (crypto.randomBytes(32))
- Expira 72h
- Registra IP+user_agent acumulado em arrays
- Aprovação OU rejeição com nome+email do aprovador
- Aprovação dispara side-effect: cria \`accounts_payable\` automático + atualiza OC status='in_payable' + payable_id

**Régua de vencimento**: lê \`suppliers.payment_terms\` ('15'/'30'/'D+45') → due_date.`,
    tags: ['dropship', 'oc', 'portal', 'aprovacao'],
  },
  {
    routes:   ['/dashboard/dropship/sync-logs'],
    category: 'dropship',
    title:    'Logs de sincronização do catálogo',
    content: `**Histórico de imports/syncs do catálogo** dropship. Cada import de planilha cria 1 row em \`dropship_sync_logs\` com:
- Counters (processados / criados / atualizados / falhas)
- significant_cost_changes JSONB (lista de SKUs com mudança >5%)
- out_of_stock_skus[]
- validation_errors JSONB (linhas que falharam com motivo)
- Status: running → completed / partial / failed

**Filtro deep-link**: \`?supplier_id=X\` filtra logs daquele parceiro (botão "Logs" no detalhe do parceiro).

**v1 popula via**: spreadsheet_import (POST /partner-products/bulk-import). Outros sync types (api_pull, sftp, csv_email) ficam pra futuras integrações.`,
    tags: ['dropship', 'sync', 'logs'],
  },
  {
    routes:   ['/dashboard/dropship/returns'],
    category: 'dropship',
    title:    'Devoluções dropship + régua de crédito',
    content: `**Devoluções abertas pelo COMPRADOR** (cancelamento, defeito, arrependimento, etc.) que geram crédito do parceiro conforme régua de 4 cenários.

**11 tipos**: cancellation / return_buyer_regret / return_defective / return_wrong_item / return_damaged / return_not_delivered / return_incomplete / warranty_claim / reclamation_refund / chargeback / partner_negotiated.

**Responsibility**: partner (default — gera crédito) / seller (nós absorvemos) / shared (50/50 default, configurável via responsibility_split.partner_pct) / buyer (arrependimento) / undefined.

**Régua de crédito 4 cenários** (aplicada ao aprovar):
1. \`same_oc_unpaid\`: OC ainda em draft/preview_locked → marca item excluded + recalcula totais
2. \`same_oc_approved_unpaid\`: OC sent/viewed/approved (não paga) → marca item credited + ajusta net_total dentro da OC
3. \`next_oc_credit\`: OC já paid → cria saldo em \`dropship_partner_credits\` (status pending) pra abater na próxima OC
4. \`pending_dispute\`: responsibility != partner/shared → status='disputed', sem crédito

**Auto-aplicação na OC do dia**: cron @22h após criar OC chama applyPendingCreditsToOC FIFO — itera credits pending do supplier, aplica até zerar gross ou esgotar saldo, decompõe por type (return/cancellation/warranty/etc.) na OC.

**v1 criação manual**. Webhooks ML/Shopee deferidos pra v2 (precisa registrar em ML Application + endpoint público com HMAC).`,
    tags: ['dropship', 'returns', 'credits', 'regua'],
  },
  {
    routes:   ['/dashboard/dropship/credits'],
    category: 'dropship',
    title:    'Saldo de créditos do parceiro',
    content: `**Créditos pendentes** (\`dropship_partner_credits\` status='pending') que serão aplicados na próxima OC do parceiro automaticamente.

**Fontes**:
- Devoluções aprovadas com cenário \`next_oc_credit\` (OC original já paga)
- Ajustes manuais (status='manual_adjustment')
- Pagamento anterior excedente (status='previous_payment')

**7 credit_types**: return / cancellation / warranty / divergence / manual_adjustment / negotiated_discount / previous_payment. Cada tipo decompõe em campo correto da próxima OC (return_credits, cancellation_credits, warranty_credits, divergence_credits, other_credits).

**\`/dashboard/dropship/credits\`** mostra saldo total + cards por parceiro (pending/applied/count) + lista detalhada com link "Ver OC" quando applied_to_oc_id preenchido.

**FIFO**: ao aplicar créditos numa OC nova, ordena por created_at ascending. Suporta aplicação parcial (status \`partially_applied\`).`,
    tags: ['dropship', 'credits', 'saldo'],
  },
  {
    routes:   ['/dashboard/dropship/disputes'],
    category: 'dropship',
    title:    'Disputas — contestações entre seller e parceiro',
    content: `**Disputas ≠ Devoluções**: returns são abertas pelo comprador. Disputas são abertas pelo SELLER ou PARCEIRO contestando algum valor/responsabilidade.

**6 dispute_types**: cost_divergence (custo divergente da OC) / responsibility (quem absorve devolução) / amount (valor do crédito) / product_returned (parceiro alega não receber) / item_inclusion (item não deveria estar na OC) / other.

**8 status**: open → in_review → mediation → resolved_(partner|seller|compromise) → closed. Ou escalated (jurídico/manual).

**Side-effects**:
- Criar dispute vinculada a return → atualiza return.status='disputed'
- Resolver dispute (resolved_partner) → return volta pra 'approved'
- Resolver dispute (resolved_seller) → return.status='rejected'
- Resolver dispute (resolved_compromise) → return.status='analyzed' (operador decide depois)

**Modal Resolver** pede: tipo de resolução (3 opções) + final_resolved_amount + texto de resolução obrigatório (vai pro registro de auditoria).`,
    tags: ['dropship', 'disputes', 'conflito'],
  },
  {
    routes:   ['/dashboard/dropship/scores'],
    category: 'dropship',
    title:    'Score do parceiro v1 (5 dimensões × 20pts)',
    content: `**Score 0-100 mensal** dos parceiros dropship. Cron @00:30 dia 1 do mês calcula score do mês ANTERIOR (período fixo: 1º do mês passado → 1º deste).

**5 dimensões cada 0-20 pts**:
1. \`stock_accuracy\` = 20 × (active_skus - oos) / active_skus
2. \`ship_lead_compliance\` = 20 × (orders sem atraso >48h shipped lag)
3. \`divergence_rate\` = 20 × (1 - divergencesCount/orders) — populado quando Sprint 12 detecta
4. \`return_rate\` = 20 × (1 - credit_applied returns / orders)
5. \`approval_speed\` = 20 - (avg_approval_hours / 24) × 5

**Sem dados** retorna 16-18 pts (neutro, não penaliza parceiros novos).

**Insights gerados** (basic v1, IA na v2): warning se dimensão <14, improvement se score subiu ≥5pts vs mês anterior.

**\`/dashboard/dropship/scores\`** — ranking ordenado por total_score desc:
- 4 KPIs (parceiros pontuados / score médio / top score / em risco<60)
- Cards expandíveis: posição #N (1-3 com troféus gold/silver/bronze) + score grande colorido (verde≥80, amber≥60, red<60) + indicator change (TrendingUp/Down)
- Click expande: 5 dimensões com barras coloridas + insights (improvement/warning)

**Botão "Recalcular agora"** força fora do cron (útil pra testar). Atualiza \`supplier_dropship_profiles.partner_score\` após cálculo.`,
    tags: ['dropship', 'score', 'ranking', 'kpi'],
  },
  {
    routes:   ['/dashboard/dropship/divergences'],
    category: 'dropship',
    title:    'Divergências detectadas automaticamente',
    content: `**Cron @02h diário** scan-eia 3 regras automáticas:

1. **\`shipment_delay\`**: identifications sem shipped_at após 48h.
   Severity: 48-72h=medium, 72-96h=high, >96h=critical.
   Ação sugerida: contatar parceiro pra confirmar status.

2. **\`missing_partner_product\`**: identifications on_hold com hold_reason "%mapeamento%".
   Severity: high.
   Ação: cadastrar produto no catálogo do parceiro ou pausar anúncio.

3. **\`price_below_cost\`**: products.price < unit_cost+packaging+handling.
   Severity: critical.
   Ação: reajustar preço ou pausar anúncio.

**Outras 6 regras planejadas v2**: cost_change_uninformed, cost_at_oc_different, stock_inconsistency, no_shipment_confirmation, return_amount_mismatch, duplicate_oc_item.

**Idempotência**: UNIQUE constraint composto (type + refs) WHERE status IN open/ack/investig garante que não cria duplicada.

**Workflow status**: open → acknowledged → investigating → resolved / ignored. Operador clica botões inline (CheckCircle2 / EyeOff) com prompts de notas/motivo.

**4 severities** com border-left colorido nos cards: critical=red / high=orange / medium=amber / low=gray.

**Botão "Escanear agora"** força run fora do cron @02h.`,
    tags: ['dropship', 'divergencias', 'regras', 'auto'],
  },
  {
    routes:   ['/dashboard/dropship/copilot'],
    category: 'dropship',
    title:    'Copiloto IA do Dropship',
    content: `**Chat com IA** focado no dropship (\`/dashboard/dropship/copilot\`).

**Como funciona** (v1):
1. Operador faz pergunta em texto livre
2. Backend coleta contexto agregado: KPIs do dashboard, top 10 scores, parceiros at risk, devoluções abertas, divergências críticas
3. Monta system prompt PT-BR focado: usar APENAS dados reais, sugerir ações com nome de tela, max 4 parágrafos
4. Chama LlmService.generateText feature='copilot_help' (Haiku 4.5 com fallback Sonnet)
5. Resposta em texto livre (sem tool calling em v1)

**Sugestões iniciais** (clicáveis):
- "Quais parceiros estão em risco hoje?"
- "Quanto eu tenho a pagar nos próximos 7 dias?"
- "Quais devoluções estão abertas?"
- "Que divergências críticas tenho?"
- "Como está o score do top parceiro?"
- "Quais SKUs estão sem estoque?"

**Tools/function calling** deferido pra v2 (precisaria estender LlmService pra expor a interface tools-aware do Anthropic SDK).

**Custo**: ~$0.001-0.005/mensagem (Haiku 4.5 é barato). Logged em ai_usage_log via LlmService.`,
    tags: ['dropship', 'copilot', 'ia', 'chat'],
  },
  {
    routes:   ['/portal/oc/[token]'],
    category: 'dropship',
    title:    'Portal público do parceiro (sem login)',
    content: `**Rota pública**: \`/portal/oc/[token]\` — fora do dashboard, sem auth.

**Como o parceiro chega aqui**: e-mail/WhatsApp com link disparado pelo seller via botão "Enviar Parceiro" na detalhe da OC.

**Token**: 64 chars hex aleatório (\`crypto.randomBytes(32).toString('hex')\`). Expira 72h. Cada acesso registra IP + user_agent acumulado em arrays pra auditoria.

**Tela do parceiro** mostra:
- Header eClick + número OC + countdown do token
- Card Parceiro (CNPJ/razão social/marketplace/datas/payment_terms)
- 3 KPIs grandes (Bruto / Créditos / Líquido cyan)
- Breakdown de créditos (5 tipos) quando total>0
- Tabela items com thumb + custo decomposto
- Notas seller (se houver)

**2 ações**:
- **Aprovar**: nome+email obrigatórios + notas opcional. Se notas preenchido vira \`approved_with_notes\`. Side-effect: cria \`accounts_payable\` automático e atualiza OC pra \`in_payable\`.
- **Rejeitar**: motivo obrigatório (vai pro \`partner_rejection_reason\`). Sem crédito.

**Estados**: já processada / link expirado / link inválido com mensagens claras.`,
    tags: ['dropship', 'portal', 'parceiro', 'publico'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// Financeiro — Contas a Pagar (Sprint 7 dropship)
// ════════════════════════════════════════════════════════════════════════

const FINANCEIRO_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/financeiro/contas-a-pagar', '/dashboard/financeiro/contas-a-pagar/[id]'],
    category: 'financeiro',
    title:    'Contas a Pagar (módulo financeiro genérico)',
    content: `**Módulo \`accounts_payable\` polimórfico** que serve qualquer fluxo de saída — não só dropship.

**Source types** (9): \`dropship_oc\` (auto-criado quando OC dropship aprovada via portal) / \`purchase_order\` (importação — futura integração) / \`manual\` (lançamento manual) / \`service\` / \`rent\` / \`tax\` / \`salary\` / \`utility\` / \`other\`.

**Auto-criação dropship**: quando parceiro aprova OC no portal, side-effect cria payable com:
- description: \`OC {oc_number} · {marketplace_account}\`
- amount: \`oc.net_total\`
- due_date: \`oc.due_date\` (calculada de \`suppliers.payment_terms\`)
- beneficiary_name: parceiro (denormalizado)
- category: 'CMV Dropship'
- metadata: { oc_id, oc_number }
+ atualiza \`oc.payable_id\` + status='in_payable'.
UNIQUE (source_type, source_id) garante idempotência.

**Numeração**: \`AP-YYYYMM-NNNN\` (sequencial mensal por org).

**5 status**: pending → partial / paid / overdue / cancelled. Cron @06h marca pending/partial com due_date<today como overdue.

**\`/dashboard/financeiro/contas-a-pagar\`** mostra 5 KPIs (Em aberto / Vencidas / Próx 7d / Próx 30d / Pago no mês), filtros (Em aberto agregado / Vencidas / Pendentes / Parciais / Pagas / Todas), search por descrição/beneficiário/número.

**Modal Pagar** suporta pagamento parcial (\`paid_amount\`), 8 métodos (pix/boleto/transfer/check/cash/credit_card/debit_card/other), URL comprovante (paste manual). Quando totalmente pago + source=dropship_oc → side-effect: marca OC como \`paid\` com payment_method/reference.

**Cancelar** rejeita se já paga.`,
    tags: ['financeiro', 'contas-a-pagar', 'payable', 'dropship'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// Onda 12 — F10 ML Listing Center IA (Sprint 1 — L1 Foundation + Agregação)
// ════════════════════════════════════════════════════════════════════════

const ML_LISTING_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/listings', '/dashboard/listings/tasks', '/dashboard/listings/tasks/[id]'],
    category: 'listing-center',
    title:    'ML Listing Center — central de tarefas dos anúncios',
    content:  `**ML Listing Center IA (F10)** é a tela única onde o lojista vê tudo que precisa fazer hoje em seus anúncios ML, **priorizado por impacto financeiro**. Não duplica lógica: agrega sinais do **Quality Center (F7)**, **Campaign Center (F8)** e **Dropship Center (F9)** via VIEW SQL, e adiciona scanners próprios.

**Tipos de tarefa** atuais (Sprint 1 entrega L1):
- \`OUT_OF_STOCK\` — anúncio sem estoque (scanner próprio)
- \`QUALITY_LOW\` / \`QUALITY_INCOMPLETE\` — agregado do F7
- \`PROMOTION_AVAILABLE\` / \`PROMOTION_HIGH_OPPORTUNITY\` — agregado do F8
- \`DROPSHIP_PARTNER_OUT_OF_STOCK\` — agregado do F9
- (futuras): \`PRICE_HIGH\`, \`LOSING_BUY_BOX\`, \`PRICE_AUTOMATION_AVAILABLE\`, \`FISCAL_DATA_MISSING\`, \`CATALOG_ELIGIBLE\`, \`INACTIVE_PAUSED\`

**Severities**: \`critical\` / \`high\` / \`medium\` / \`low\` — define prioridade.

**Status**: \`open\` (precisa ação) / \`snoozed\` (adiada N dias) / \`in_progress\` / \`resolved_auto\` (sinal sumiu) / \`resolved_manual\` (operador) / \`dismissed\` (descartada) / \`expired\`.

**Auto-resolve**: tasks agregadas (do F7/F8/F9) que não aparecem mais na VIEW por >6h são marcadas como \`resolved_auto\` automaticamente. Tasks de \`scanner_stock\` que voltam a ter estoque idem.

**Como usar**:
1. Tela \`/dashboard/listings\` mostra summary (críticas / impacto R$ / por tipo).
2. Filtrar tasks por tipo, severidade, item ou seller_id.
3. Cada task tem \`deeplink_url\` apontando pro módulo onde resolve (ex: tarefas \`QUALITY_LOW\` levam pro Quality Center). Listing Center é a **porta de entrada**, mas resolução acontece no módulo dono.
4. Snooze (1-90 dias) / Dismiss (descarta com motivo) / Resolve manual (com nota).

**Endpoints principais (auth):**
- \`GET /listings/summary?seller_id=\` — totais por severidade + por tipo + impacto R$
- \`GET /listings/tasks?task_type=&severity=&status=&seller_id=&offset=&limit=\` — listar
- \`PATCH /listings/tasks/:id\` body=\`{action:'snooze'|'dismiss'|'resolve', days?, reason?, notes?}\`
- \`POST /listings/scan/full\` body=\`{seller_id}\` — agregação + scanner stock
- \`POST /listings/scan/stock\` body=\`{seller_id}\` — só scanner stock
- \`POST /listings/scan/aggregation\` — só lê VIEW (rápido, sem ML)
- \`GET /listings/out-of-stock?seller_id=\` — atalho

**Multi-conta**: cada task tem \`seller_id\` próprio. Scans devem receber \`seller_id\` no body (gotcha multi-conta — sem isso, pega token da conta com updated_at mais recente).

**Spec canônica**: \`docs/ml-listing-center-spec.md\`. Smoke test dos endpoints novos em \`scripts/smoke-test-pricing-endpoints.mjs\`.`,
    tags: ['listings', 'tasks', 'agregação', 'f7', 'f8', 'f9', 'multi-conta'],
  },
  {
    routes:   ['/dashboard/listings/items/[itemId]', '/dashboard/listings/out-of-stock', '/dashboard/listings/inactive'],
    category: 'listing-center',
    title:    'Visão consolidada por anúncio + atalhos (sem estoque, pausados)',
    content:  `Na rota \`/dashboard/listings/items/{itemId}\` o lojista vê **todas** as tarefas pendentes daquele anúncio em um só lugar — qualidade, preço, fiscal, estoque, promoção, status. Atalhos do sidebar via \`?type=OUT_OF_STOCK\` ou \`?type=INACTIVE_PAUSED\` filtram a tela principal.

**Scanner de estoque** (\`scanner_stock\`):
- Lista \`/users/{seller}/items/search?status=active\` (paginado 50/page até 5000)
- Pra cada item: \`GET /items/{id}?attributes=id,available_quantity,sold_quantity,price,title,last_updated\`
- Pacing 100ms entre calls (= 10 req/s, ML aguenta sem 429)
- Severity por sold_quantity + last_updated: \`critical\` (sold>50 + <7d), \`high\` (>10), \`medium\` (>0), \`low\`
- Auto-resolve quando estoque volta (>6h sem aparecer)

**Scanner de status** (\`scanner_status\` — Sprint 2):
- Lista \`/users/{seller}/items/search?status=paused\` + \`status=closed\`
- Pra cada item: GET full pra inspecionar \`sub_status\`, \`tags\`, \`warnings\`
- Classificação genérica v1 (out_of_stock / moderation_pending / warning / pausado_pelo_vendedor / closed). L3 vai refinar pra mais categorias específicas.
- Severity por motivo: out_of_stock=high, moderation=high, warning=high, closed_com_vendas=medium, closed_sem_vendas=low
- Auto-resolve quando item volta pra active (>6h sem aparecer como pausado/closed)
- Endpoint: \`POST /listings/scan/status\` body=\`{seller_id}\`

**Full scan** (\`POST /listings/scan/full\`) executa em sequência: agregação F7/F8/F9 + scanner stock + scanner status + scanner pricing. Latência ~5-10min pra 1000+ anúncios. Cada scanner roda independente — falha em um não derruba os outros.`,
    tags: ['listings', 'estoque', 'pausados', 'scanner', 'status'],
  },
  {
    routes:   ['/dashboard/listings/pricing'],
    category: 'listing-center',
    title:    'Pricing IA — sugestões de preço via price_to_win',
    content:  `Tela \`/dashboard/listings/pricing\` mostra **anúncios com sugestão de preço**, ordenados por diferença % (atual vs sugerido). Vem do endpoint \`/items/{id}/price_to_win\` da ML — muito mais rico que o que a spec original previa.

**Dados que cada sugestão traz:**
- \`current_price\` × \`suggested_price\` (= price_to_win)
- \`buy_box_status\`: **winning** / **losing** / **sharing_first_place**
- \`visit_share\`: maximum / medium / low (proxy de visibilidade)
- \`competitors_sharing\`: quantos concorrentes empatam o 1º lugar
- \`reason[]\`: motivos de estar perdendo (quando aplica)
- \`catalog_product_id\`: vincula ao catálogo ML (Sprint 4 vai usar pra card CATALOG_ELIGIBLE)
- \`winner\`: item_id + preço de quem está vencendo
- \`boosts\`: free_shipping, fulfillment, cross_docking, etc. (alimenta scanners de Full e frete)
- \`internal_margin_at_suggested_pct\`: margem que sobra ao aplicar a sugestão (cruzando com cost_price local)
- \`is_below_cost\` / \`is_below_min_margin\`: validações pra mode=safe

**Tarefas geradas pelo scanner pricing:**
- \`PRICE_HIGH\` quando diff ≥ 5% e não abaixo do custo
- \`LOSING_BUY_BOX\` quando status='losing' OU competitors_sharing > 0

**Aplicar preço:**
- Botão **Aplicar** chama \`POST /listings/pricing/apply/:itemId\` mode=safe.
- Mode safe valida: skip se abaixo do custo (\`skipped_reason='price_below_cost'\`) ou margem abaixo do mínimo (default 15%, \`skipped_reason='below_min_margin'\`).
- Botão **Forçar** (aparece quando is_below_cost) usa mode=force pra ignorar validações.
- PUT /items/{id} no ML; ao sucesso, current_price é atualizado e tasks abertas desse item viram resolved_manual.

**Scanner é 2-step (pós-smoke-test 2026-05-10):**
1. \`GET /suggestions/user/{seller}/items\` — lista IDs com sugestão (1 call, retorna até ~1k)
2. Pra cada ID: \`GET /items/{id}/price_to_win\` (pacing 200ms = 5 req/s)

Latência: 140 itens (Vazzo) × 200ms ≈ 28s.

**Endpoints (auth):**
- \`POST /listings/scan/pricing\` body=\`{seller_id}\`
- \`GET  /listings/pricing/suggestions?seller_id=&buy_box_status=&min_diff_pct=\`
- \`GET  /listings/pricing/suggestions/:itemId?seller_id=\`
- \`POST /listings/pricing/apply/:itemId\` body=\`{seller_id, mode='safe'|'force', price?}\``,
    tags: ['listings', 'pricing', 'price-to-win', 'buy-box', 'apply', 'multi-conta'],
  },
  {
    routes:   ['/dashboard/listings/pricing/automation'],
    category: 'listing-center',
    title:    'Automação de preço ML + Catálogo (Sprint 4 / fecha L2)',
    content:  `**Automação de preço** (\`/pricing-automation/*\` da ML) deixa o ML ajustar o preço sozinho dentro de min_price/max_price configurados.

**Tela** \`/dashboard/listings/pricing/automation\` mostra cards por item com:
- **Status**: Ativa (verde) / Pausada (amarelo) / Elegível (azul) / Sem regras (cinza)
- **Regra ativa**: \`INT\` (competitivo dentro do ML) ou \`INT_EXT\` (dentro + fora do ML)
- **Limites**: min/max em R$
- **Badge "Bloqueia edição manual"** quando status=ACTIVE — ⚠️ a partir de 18/03/2026 ML rejeita PUT /items/{id} price quando automação ativa.
- **Pausa por motivo**: se cause=PROMO, é normal (promoção ativa). Outros motivos → \`review_pause\`.

**Filtros**: Todos / Elegíveis / Ativos / Pausados (chips no topo).

**Ações por card** (chamam endpoints POST):
- **Ativar** (azul, elegíveis): modal pede rule_id + min/max → \`POST /pricing-automation/items/:id/activate\`
- **Limites** (cyan, ativos): modal pré-preenchido → \`POST /configure\`
- **Pausar** (amber, ativos): \`POST /pause\`
- **Retomar** (verde, pausados): chama activate de novo
- **Desativar** (rose, qualquer automatizado): \`POST /disable\` → DELETE no ML

**Scanner híbrido** (low-cost):
1. GET /pricing-automation/users/{seller}/items → IDs automatizados (1 call)
2. Pra cada AUTOMATIZADO: GET /rules + GET /automation (2 calls)
3. Pra items COM SUGESTÃO de preço em cache (candidatos óbvios): GET /rules (1 call)
4. Pacing 200ms entre calls

**Recomendação interna** (gerada pelo scanner):
- \`activate\`: tem rules mas não usa → cria task \`PRICE_AUTOMATION_AVAILABLE\` severity=low
- \`configure_limits\`: ativa SEM min/max → severity=high (risco de margem)
- \`review_pause\`: pausada por motivo não-PROMO → severity=medium
- \`no_action\`: tudo ok

**Card CATALOG_ELIGIBLE** (scanner_catalog, mesmo Sprint 4):
Aproveita \`catalog_product_id\` já em cache do scanner_pricing. Pra cada item com catálogo: GET /products/{catalog_id}/items → compara nossa posição vs top-3. Cria task quando:
- Posição > 3 no catálogo
- Competidor top tem frete grátis E nós não
- Competidor top usa Full E nós não

**Endpoints (auth):**
- \`POST /listings/scan/automation\` body=\`{seller_id}\`
- \`POST /listings/scan/catalog\` body=\`{seller_id}\`
- \`GET  /listings/pricing/automation?filter=all|eligible|active|paused\`
- \`POST /listings/pricing/automation/:itemId/activate\` body=\`{seller_id, rule_id?, min_price?, max_price?}\`
- \`POST /listings/pricing/automation/:itemId/pause\`
- \`POST /listings/pricing/automation/:itemId/configure\` body=\`{seller_id, min_price, max_price}\`
- \`POST /listings/pricing/automation/:itemId/disable\`

**Atalhos no sidebar**: "Automação preço" (tela), "Catálogo" (filtro \`?type=CATALOG_ELIGIBLE\` na tela principal).`,
    tags: ['listings', 'pricing-automation', 'catalogo', 'buy-box', 'multi-conta'],
  },
  {
    routes:   ['/dashboard/listings/fiscal'],
    category: 'listing-center',
    title:    'Fiscal NF-e — NCM, GTIN, origem (Sprint 5 / L3)',
    content:  `Tela \`/dashboard/listings/fiscal\` lista anúncios por **compliance fiscal**. Mostra os 6 atributos checados (NCM, GTIN, ORIGIN, CEST, BRAND, MODEL) com badge verde (presente) ou vermelho (ausente).

**Bloqueia NF-e** quando NCM, GTIN OU ORIGIN estão ausentes — esses 3 são obrigatórios pra emissão de nota fiscal. Cria task \`FISCAL_DATA_MISSING\` severity=high.

**Score fiscal**: % dos 6 checks que passam (0-100).

**Aplicar correção**: botão "Corrigir" abre modal com inputs pros campos faltando. Submit chama \`POST /listings/fiscal/:itemId/fix\` body=\`{seller_id, fixes: [{id: 'NCM', value_name: '...'}, ...]}\`. Backend faz \`PUT /items/{id}\` no ML com os atributos. Após sucesso, re-fetch o item pra atualizar snapshot + resolve task como \`resolved_manual\` se não bloqueia mais.

**Scanner fiscal**:
- Lista todos items ativos do seller via /users/{seller}/items/search (paginado 50/page até 5000)
- Pra cada: \`GET /items/{id}?attributes=id,attributes,status,title,price\`
- Pacing 100ms (10 req/s)
- Auto-resolve: tasks abertas que não viram bloqueio em >6h viram resolved_auto

**Endpoints (auth):**
- \`POST /listings/scan/fiscal\` body=\`{seller_id}\`
- \`GET  /listings/fiscal?seller_id=&blocked_only=true\`
- \`GET  /listings/fiscal/blocked-nfe?seller_id=\` (atalho)
- \`POST /listings/fiscal/:itemId/fix\` body=\`{seller_id, fixes[]}\`

**Atalho no sidebar**: "Fiscal (NF-e)" → /dashboard/listings/fiscal.

**Importante**: atributos fiscais ficam no ANÚNCIO (PUT /items/{id}), não no produto do catálogo. Mesmo item migrado de produto pode ter atributos diferentes do esperado.`,
    tags: ['listings', 'fiscal', 'nfe', 'ncm', 'gtin', 'compliance', 'multi-conta'],
  },
  {
    routes:   ['/dashboard/listings/policy'],
    category: 'listing-center',
    title:    'Política & motivos de pausa (Sprint 6 / fecha L3)',
    content:  `Tela \`/dashboard/listings/policy\` mostra anúncios pausados/inativos **agrupados por motivo específico** com sugestão de correção pra cada categoria.

**12 categorias** (severity-sorted):
- **critical**: \`policy_violation\` (anúncio viola política — contestar) · \`restricted_product\` (produto restrito pelo ML)
- **high**: \`moderation_pending\` (aguardar análise) · \`out_of_stock\` (repor estoque)
- **medium**: \`image_problem\` (foto não atende) · \`description_problem\` (termos proibidos/links) · \`price_problem\` (valor inválido) · \`category_problem\` (categoria errada) · \`incomplete_required_fields\` (atributos faltando)
- **low**: \`paused_by_seller\` (pausa voluntária) · \`expired\` (validade venceu) · \`unknown\`

**Como classifica**: o status scanner (\`POST /listings/scan/status\`) inspeciona \`sub_status\` + \`tags\` do item e mapeia pra uma das categorias acima. Salva tudo em \`ml_listing_pause_classifications\` (1 row por item).

**Campos**: pause_category, pause_severity, is_self_solvable, suggested_fix, paused_since, days_paused, item meta (title, price, sold_quantity) pra UI sem re-fetch.

**Endpoints (auth):**
- \`GET /listings/policy/by-category?seller_id=\` — agrupado, com até 50 amostras por categoria
- \`GET /listings/policy/critical?seller_id=\` — só policy_violation + restricted_product
- \`GET /listings/policy?seller_id=&category=&limit=\` — lista filtrada

**Tela**: cards collapsible por categoria com:
- Pill severity colorida
- Contador + descrição + fix sugerido
- Click expande → lista os itens (link pra anúncio + ML + dias parado + vendas)
- Badge "Resolvível" pra itens com is_self_solvable=true (operador consegue corrigir sem ML)

**Atalho no sidebar**: "Política & motivos" → /dashboard/listings/policy.

Sprint 6 fecha L3. Próximo: L4 (score consolidado + copiloto + bulk).`,
    tags: ['listings', 'policy', 'pause-classification', 'compliance', 'multi-conta'],
  },
  {
    routes:   ['/dashboard/listings/scores'],
    category: 'listing-center',
    title:    'Health Score — saúde consolidada por anúncio (Sprint 7 / L4)',
    content:  `Tela \`/dashboard/listings/scores\` mostra **score 0-100 por anúncio** combinando 6 dimensões em uma só nota:

**Breakdown** (weighted average):
- \`quality_score\` (peso 25%) — F7 Quality Center (ml_quality_snapshots.ml_score)
- \`pricing_score\` (peso 20%) — L2 (winning=100, sharing=70, losing=20-55 conforme diff)
- \`fiscal_score\` (peso 15%) — L3 (% atributos NCM/GTIN/ORIGIN/etc presentes)
- \`status_score\` (peso 15%) — L1 (100 se active, 0 se paused/closed)
- \`margin_score\` (peso 15%) — interno (margem do produto vinculado; default 50 se sem dado)
- \`sales_score\` (peso 10%) — orders dos últimos 30d normalizados pelo p90 da conta

**Insights determinísticos** (sem custo IA pra MVP):
- \`key_issues[]\`: detecta automaticamente quality_low, price_high, losing_buy_box, fiscal_incomplete, inactive, margin_low, low_sales
- \`top_recommendation\`: texto direto priorizando bloqueios > exposição > monetização
- \`top_recommendation_action\`: enum acionável (fix_fiscal | improve_quality | reduce_price | activate_automation | replenish_stock | reactivate | improve_margin | apply_promotion | none)

**Trend**: comparando com cálculo anterior → improving / stable / degrading. \`score_change\` tem o delta numérico.

**Endpoints (auth):**
- \`POST /listings/health/calculate\` body=\`{seller_id}\` — recalcula tudo (lê todos os caches, ~3s pra Vazzo)
- \`GET  /listings/health?seller_id=&min_score=&max_score=&limit=\` — lista ordenada por score asc
- \`GET  /listings/health/:itemId\` — detalhe

**Performance**: motor faz Promise.all de 6 queries SQL (caches existentes) + agregação em memória. ZERO chamadas ML. Pra 381 items do Vazzo: ~3s. Pra 5000 itens: ~10s.

**Tela**: cards com score gigante esquerda + trend icon, breakdown bars coloridas (6 dimensões), recommendation em destaque, chips de issues + action sugerida. Filtros: Críticos (<60) / Todos / Saudáveis (≥80).

**Atalho no sidebar**: "Health Score" → /dashboard/listings/scores.`,
    tags: ['listings', 'health-score', 'consolidado', 'insights', 'recommendation', 'multi-conta'],
  },
  {
    routes:   ['/dashboard/listings/bulk'],
    category: 'listing-center',
    title:    'Ações em massa — apply/resolve/snooze em lote (Sprint 8 / fecha L4)',
    content:  `Tela \`/dashboard/listings/bulk\` mostra **histórico de bulk actions** com progress bar em tempo real (polling 3s enquanto status ∈ pending/validating/executing).

**4 operações suportadas no MVP:**

1. **\`apply_price_suggestions\`** — aplica price_to_win em lote. Acionado pelo botão "Aplicar em lote" na tela /pricing (selecionar checkboxes nos cards). Modes:
   - \`safe\` (default): pula items abaixo do custo ou abaixo da margem mínima
   - \`best_effort\`: força aplicação (= mode 'force' do apply individual)
   - \`dry_run\`: simula sem aplicar — útil pra preview antes de comprometer

2. **\`resolve_tasks_manual\`** — bulk update de tasks pra status='resolved_manual'

3. **\`snooze_tasks\`** — adia N tasks por X dias (default 7)

4. **\`dismiss_tasks\`** — descarta N tasks com motivo

**Endpoints (auth, todos retornam 202 + bulk_action_id):**
- \`POST /listings/bulk/apply-prices\` body=\`{seller_id, item_ids[], apply_mode?}\`
- \`POST /listings/bulk/resolve-tasks\` body=\`{seller_id, task_ids[], notes?}\`
- \`POST /listings/bulk/snooze-tasks\` body=\`{seller_id, task_ids[], days?}\`
- \`POST /listings/bulk/dismiss-tasks\` body=\`{seller_id, task_ids[], reason?}\`
- \`GET  /listings/bulk/actions?seller_id=&limit=\` — lista histórico
- \`GET  /listings/bulk/actions/:id\` — detalhe com results[]

**Execução**: fire-and-forget. UI polls a cada 3s enquanto action está ativa. Pricing apply tem pacing 300ms entre items pra não saturar ML. Bulk de tasks é UPDATE em batches de 100.

**Auditoria**: results[] guarda \`{ item_id_or_task_id, status: applied|failed|skipped, message?, new_price? }\` por item. Permite reconstruir histórico exato de quem aplicou o quê.

**Quando ML rejeita** (price abaixo do custo, automação ativa bloqueia edit, etc.): status='skipped' com message explicativa. UI mostra em chip amarelo.

**Atalho no sidebar**: "Ações em massa" → /dashboard/listings/bulk.

## Comandos pro copiloto (KB inteligente)

O copilot flutuante reconhece comandos como:
- "Aplique sugestões de preço nos top 20 anúncios saudáveis"
- "Adie todas as tarefas de qualidade baixa por 7 dias"
- "Mostre o histórico de bulk actions de hoje"
- "Quais anúncios estão perdendo Buy Box agora?"
- "Liste anúncios sem custo cadastrado que estão bloqueando NF-e"

O copilot delega cada query via API GET correspondente (tasks?type=, suggestions?buy_box_status=, fiscal?blocked_only=true, health?max_score=) e ações via POST bulk/*.

Sprint 8 fecha L4 e o módulo F10 inteiro. Próximo: refinamentos pós-feedback do usuário.`,
    tags: ['listings', 'bulk-actions', 'auditoria', 'copilot', 'multi-conta'],
  },
  {
    routes:   ['/dashboard/listings', '/dashboard/listings/seo-optimizer'],
    category: 'listing-center',
    title:    'SEO Scanner — score estrutural diário + Top ROI (Passo 2/3)',
    content:  `Passo 2 do roadmap SEO: scanner diário calcula **score estrutural 0-100** pra cada anúncio ativo sem chamar LLM (regra cara — usa o e-Otimizer manual pra isso). Roda dentro do \`runFullScan\` (cron 02:30 BRT), portanto sem cron próprio.

**Como o score é calculado** (peso entre parênteses):
- **Título (40%)**: 0-30 chars = ruim, 30-60 = bom, sweet-spot 50-60 = 95
- **Atributos (40%)**: lê \`ml_quality_snapshots\` (Sprint F7) — % preenchido entre PI (ficha) + FT (técnico). Penaliza pra ≤40 se ML está marcando \`has_exposure_penalty\`
- **Fotos (20%)**: <3 = ruim (30), 3-5 = ok (65), ≥6 = ideal (100)
- Descrição não é scoreada (eviting per-item GET) — pendência v2

Score persistido em \`ml_listing_seo_scores\` com snapshot completo (title, length, pictures_count, attributes_missing, visits_30d, issues[]). UNIQUE \`(org, seller, ml_item_id)\` — upsert por item.

**Quando vira task ml_listing_tasks:**
- \`SEO_LOW\` — score < 60. Severidade derivada (<30 critical, <50 high, <60 medium)
- \`SEO_HIGH_VISITS_LOW_SCORE\` — score 60-70 E visits_30d ≥ 100. **Prioridade alta** porque tráfego já existe; otimizar = converter o que está vindo

**Auto-resolve:** se score subiu pra ≥60 após otimização do user, task fecha sozinha na próxima rodada do scanner (status=\`resolved_auto\`).

**Top ROI (Passo 3):** \`GET /listings/seo/top-opportunities?limit=10\` retorna anúncios ordenados por \`visitas_30d × (100 - score)\` — fórmula prioriza alto tráfego E score baixo. UI: card cyan no topo de \`/dashboard/listings\` listando top 5 com deeplink direto pro Optimizer (\`/dashboard/listings/seo-optimizer?mlbId=...\`).

**Endpoints (auth):**
- \`POST /listings/scan/seo\` body=\`{seller_id}\` — roda scan isolado on-demand
- \`GET /listings/seo/scores?max_score=&min_visits=&seller_id=&limit=\` — lista paginada (piores primeiro)
- \`GET /listings/seo/top-opportunities?limit=10\` — Top ROI (visitas × score)
- \`GET /listings/seo/scores/:itemId\` — score detalhado de 1 anúncio

**Fonte de visitas:** \`ml_item_visits_period\` (populado pelo F11 visits-scanner). Normalizo o período pra escala 30 dias via \`(total_visits / period_days) * 30\`.

**Como pro user usa:**
1. Sidebar → "Anúncios" → vê widget "Top ROI" no topo do dashboard F10
2. Click no anúncio → vai direto pro Optimizer com MLB pré-carregado e análise automática
3. Optimizer aplica IA rica (keywords categoria + research) — DIFERENTE do score estrutural que só mede estrutura

**Por que dois scores divergem (esperado):**
- Scanner = barato + escalável + sem keywords (ESTRUTURAL)
- Optimizer e-otimizer = caro + per-item + COM keywords da categoria (RICO)

UI deixa explícito que cada um é uma camada.`,
    tags: ['listings', 'seo', 'optimizer', 'scanner', 'cron-diario', 'top-roi', 'visitas', 'multi-conta'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// Onda 13 — F11 ML Executive Dashboard IA (Sprint 1 — E1 Foundation + Agregação)
// ════════════════════════════════════════════════════════════════════════

const EXECUTIVE_DASHBOARD_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/executive', '/dashboard/executive/sales', '/dashboard/executive/refresh-logs'],
    category: 'executive-dashboard',
    title:    'ML Executive Dashboard — visão consolidada da operação',
    content:  `**F11 ML Executive Dashboard IA** é a tela "home" do operador. Em 30 segundos o lojista sabe **como está a operação ML hoje**: vendas, anúncios ativos, qualidade, campanhas, tarefas pendentes do Listing Center, alto-impacto financeiro. Atualiza a cada 15 min via cron + invalidação em tempo real via Socket.IO \`order:invalidate\` em vendas.

**Diferença vs F10 Listing Center:**
- F10 responde "o que fazer hoje neste anúncio?" (lista priorizada de tarefas por SKU)
- F11 responde "como está minha operação?" (KPIs executivos + gráficos)

**O que o E1 (Sprint 1) entrega:**

KPIs no card grid:
- **Vendas 7d** — count + GMV (\`SUM(sale_price × quantity)\`) + delta vs período anterior
- **Vendas hoje** — count + GMV em tempo real (Socket.IO subscriber em \`order:invalidate\` invalida cache parcial)
- **Anúncios ativos** — produtos com pelo menos 1 \`product_listings\` em \`platform='mercadolivre'\` e \`is_active=true\` (fonte da verdade do ML real, não \`catalog_status\` interno)
- **Qualidade baixa (F7)** — count de \`ml_quality_snapshots\` com \`ml_score < 60\` ou \`has_exposure_penalty=true\` ou \`pending_count > 0\`
- **Campanhas ativas (F8)** — \`ml_campaigns.status='started'\` + recomendações pendentes + oportunidades altas (\`opportunity_score ≥ 80\`)
- **Recomendações de alto impacto (F10)** — count e valor total em BRL das \`ml_listing_tasks\` com severity ∈ {critical, high} e \`estimated_impact_brl > 0\`

Cards futuros (E2-E4, próximas camadas — placeholders nullable hoje):
- E2 **Reputação** — gauge grande, Mercado Líder level, histórico 90d, alerta de risco
- E3 **Logística** — atrasos, Flex ativo, Full storage, envios pra despachar hoje
- E4 **Visitas + Conversão** — visitas 7d, taxa de conversão, top items "muita visita, pouca venda"

**Como funciona internamente:**

\`v_dashboard_aggregated_metrics\` (VIEW SQL) — single source of truth do agregado:
- Lê **dados reais** de F7 \`ml_quality_snapshots\`, F8 \`ml_campaigns\`/\`ml_campaign_recommendations\`, F10 \`ml_listing_tasks\`, e do core \`orders\`/\`products\`/\`product_listings\`
- **Não duplica lógica.** Se F7 mudar critério de qualidade, dashboard reflete na próxima consulta — sem deploy
- Multi-conta natural via CROSS JOIN LATERAL em \`ml_connections\` (Vazzo tem 2 sellers: VAZZO_ + ESLAR_)

\`DashboardRefreshService\` (cron \`*/15 * * * *\`):
- Para cada org com ML conectado, para cada \`seller_id\`, lê da VIEW + snapshots E2/E3/E4 e faz UPSERT em \`ml_dashboard_summary\`
- Cache permite UI carregar instantâneo. Header mostra "Atualizado há X min" + botão "Atualizar agora"
- Socket.IO subscriber em \`order:invalidate\` re-roda só a parte de vendas (~3s do bipe à UI, sem esperar 15 min)
- Logs em \`ml_dashboard_refresh_logs\` (refresh_type, status, duration_ms, api_calls_count)

**Custo:** **$0/mês em IA** — só lê do Postgres. Sem LLM, sem chamadas extra ao ML.

**Tabelas (Sprint 1 — migration 20260542):**
- \`ml_dashboard_summary\` — cache de 1 row por (org, seller_id) com todos os KPIs
- \`ml_sales_daily\` — histórico diário (gráfico 7d/30d), agregação por \`platform='mercadolivre'\`
- \`ml_dashboard_refresh_logs\` — auditoria

**Próximas camadas no roadmap:**
- E2 (Sprint 3-4) — Reputação via \`/users/{id}\` + Mercado Líder + histórico
- E3 (Sprint 5-7) — Logística: \`/shipments/{id}/delays\`, Flex, Full
- E4 (Sprint 8) — Visitas via \`/users/{id}/items_visits\` + conversão`,
    tags: ['executive-dashboard', 'home', 'kpis', 'agregacao', 'realtime', 'multi-conta'],
  },
  {
    routes:   ['/dashboard/executive/reputation'],
    category: 'executive-dashboard',
    title:    'Reputação Mercado Livre — gauge + métricas + histórico',
    content:  `**F11 E2 — Reputação** mostra o estado da reputação do seller no ML em tempo quase real (sync 1×/hora). Dados vêm de \`GET /users/{id}\` → \`seller_reputation\`.

**Componentes:**
- **Level badge gigante** com cor do \`level_id\` (5_green=Platinum, 4_light_green=Gold, 3_yellow=Mercado Líder, 2_orange=sem nível, 1_red/0_red=vermelho)
- **3 cards de métrica** (Reclamações / Cancelamentos / Atrasos de envio) cada com:
  - Taxa atual em % (rate ML é fração 0-1, multiplicada por 100 só na UI)
  - Limite Mercado Líder MLB (1% / 0.5% / 6%)
  - Status verde/amarelo/vermelho conforme thresholds amber (0.8% / 0.4% / 5%)
  - Barra de progresso até o limite
  - Trend ↑ improving / → stable / ↓ degrading (comparando snapshot anterior)
- **Risk alert amber** se alguma métrica ≥ threshold amber. Lista quais critérios bateram (\`risk_reasons[]\`).
- **3 sparklines** dos últimos até 90 dias (SVG inline sem chart lib).
- **Ratings dos compradores** (positivas / neutras / negativas).
- **Seletor de conta** quando org tem >1 seller ML conectado.
- **Botão "Sincronizar agora"** dispara \`POST /executive/reputation/sync\` (manual além do cron horário).

**Gotchas importantes (vide \`reference_ml_api_shapes_f11\`):**
- API ML usa \`claims\` (NÃO \`complaints\`). Schema da tabela e UI usam \`claims_rate\`/\`claims_count\`.
- \`period\` é string \`"60 days"\` com espaço — não \`"60d"\`.
- Limites e thresholds calibrados pra MLB. Outros sites podem ter limites diferentes.

**Endpoints (backend):**
- \`GET /executive/reputation\` — current de todas as contas da org
- \`GET /executive/reputation/history?seller_id=X&days=90\` — série temporal
- \`POST /executive/reputation/sync\` — manual (todas as contas) ou \`?seller_id=X\`

**Tabelas:**
- \`ml_seller_reputation_snapshots\` (histórico, reutilizada do ml-vertical com colunas estendidas)
- \`ml_seller_reputation_current\` (cache do mais recente + trend)

Trend = \`unknown\` na primeira sync; vira \`improving\`/\`stable\`/\`degrading\` quando há snapshot anterior pra comparar.`,
    tags: ['executive-dashboard', 'reputation', 'mercado-lider', 'risk', 'trend'],
  },
  {
    routes:   ['/dashboard/executive/logistics'],
    category: 'executive-dashboard',
    title:    'Logística — atrasos, despacho do dia e Flex',
    content:  `**F11 E3 — Logística** mostra o estado dos envios e atrasos do seller em tempo quase real. Cron diário (\`03:30 BRT\`) faz scan completo: \`/shipments/{id}/delays\` por shipment e \`/flex/sites/MLB/items/{id}/v2\` por item ativo. Cron horário (\`:23\`) só agrega counts (sem chamadas ML).

**4 cards de operação do dia:**
- **Pra despachar hoje** — count de \`orders.shipping_status='ready_to_ship'\` (sem call ML — já temos local)
- **Despachados hoje** — count de \`shipping_status='shipped'\` com \`updated_at >= 00:00\`
- **Atrasos abertos** — \`ml_shipment_delays\` com \`status='open'\`, breakdown \`h/s/t\` (handling/sla/transit)
- **Flex elegível** — items com \`has_flex=true\`, mostra cobertura do scan (% de items com entrada em \`ml_flex_status\`)

**Breakdown de atrasos por categoria:**
- \`handling_delayed\` — você atrasou pra postar (afeta \`delayed_handling_time\` rate, que é a métrica que o Mercado Líder usa)
- \`sla_delayed\` — prazo prometido ao comprador estourou
- \`transit_delayed\` — transportadora segurou (depende da Mercado Envios, menos sob controle do seller)

**Tabela de últimos atrasos detectados** com shipment_id + order_id + tipo + dias + data prevista + quando foi detectado.

**Limitação atual do Flex (documentar pro user):**
- API ML retorna SOMENTE \`{has_flex: bool}\` no endpoint \`/flex/.../v2\`. Não distingue "elegível inativo" vs "ativo entregando agora".
- Pra ativar Flex de fato, lojista usa o painel ML.

**Multi-conta:** seletor de conta quando >1 seller. Cron passa \`sellerId\` explícito em todos os \`getTokenForOrg\` (feedback_ml_multiconta_token).

**Endpoints (backend):**
- \`GET /executive/logistics\` — summary de todas as contas da org
- \`GET /executive/logistics/delays?seller_id=X&limit=50\` — atrasos abertos
- \`GET /executive/logistics/flex/eligible?seller_id=X&limit=100\` — items has_flex=true
- \`POST /executive/logistics/scan?seller_id=X\` — full scan manual (\`?kind=delays\`/\`flex\`/\`summary\` pra parcial)

**Tabelas:**
- \`ml_shipment_delays\` (unique por \`ml_shipment_id+delay_type\`, auto-resolve quando 404 da API ML)
- \`ml_flex_status\` (unique por \`org+seller+ml_item_id\`, refresh diário)
- \`ml_logistics_summary\` (1 row por org+seller — counts agregados pro dashboard)

**Dedupar shipping_id antes de iterar** (orders multi-item compartilham mesmo \`shipping.id\`). 404 do endpoint \`/delays\` = sinal POSITIVO (sem atraso) — gatilha auto-resolve de delays anteriores do mesmo shipment.

**Pendências adiadas (E3 fase 2):**
- Full (fulfillment) — endpoint não validado no smoke
- Distinguir Flex ativo vs elegível inativo — precisa de outro endpoint ainda a ser investigado`,
    tags: ['executive-dashboard', 'logistics', 'shipments', 'delays', 'flex', 'mercado-envios'],
  },
  {
    routes:   ['/dashboard/executive/visits'],
    category: 'executive-dashboard',
    title:    'Visitas + Conversão — funil de tráfego do ML',
    content:  `**F11 E4 — Visitas** mostra tráfego diário do seller no ML e calcula taxa de conversão (visitas → pedidos). Cron diário (\`03:00 BRT\`) sincroniza os últimos 7 dias de cada (org, seller) via \`/users/{id}/items_visits/time_window?last=7&unit=day\`.

**Por que time_window (não date_from/date_to)?**
A variante com \`date_from/date_to\` ISO retorna **400 BAD REQUEST** ("Invalid request unknown date format") — gotcha confirmado no smoke F11 (vide \`reference_ml_api_shapes_f11\`). \`time_window\` é a forma robusta.

**Componentes:**
- **3 KPI cards 7d:** Visitas (com delta vs 7d anteriores), Pedidos + unidades, Taxa de conversão (verde ≥5% / amarela 1–5% / vermelha <1%)
- **Card de hoje parcial** quando o último dia tem total incompleto (API agrega ao longo do dia)
- **Gráfico SVG inline** com 2 séries: visitas (linha cyan sólida) + pedidos (linha lima tracejada, escala secundária). Sem chart lib.
- **Tabela diária** com mudança vs dia anterior e vs mesmo dia da semana passada
- **Seletor de período**: 7d / 14d / 30d / 60d

**Cálculos:**
- Conversion rate = orders / visits × 100 (cruzamento Postgres com \`orders\` filtrado por seller_id + platform=mercadolivre)
- "Dia parcial" detectado quando \`date === today\` no momento do sync
- Comparações pré-computadas no sync (vs prev_day, vs same_day_last_week)

**Gotchas (vide \`reference_ml_api_shapes_f11\`):**
- API retorna \`results[]\` **fora de ordem cronológica** — backend sorta antes de gravar
- \`visits_detail[]\` permite breakdown por \`company\` (multimercados) — preservado em JSONB
- Último dia da janela é parcial — flag \`is_partial\` no schema; UI exclui dos agregados 7d

**Endpoints (backend):**
- \`GET /executive/visits?seller_id=X&days=30\` — histórico diário
- \`POST /executive/visits/sync?seller_id=X&days=30\` — manual

**Tabela:** \`ml_items_visits_daily\` (1 row por org+seller+date)

**Pendência adiada (E4 fase 2):** granularidade por item via \`/items/{id}/visits\` pra mostrar "top anúncios com muita visita, pouca venda" — endpoint não validado no smoke.`,
    tags: ['executive-dashboard', 'visits', 'conversion', 'funnel', 'tempo-real'],
  },
  {
    routes:   ['/dashboard/executive/ads'],
    category: 'executive-dashboard',
    title:    'Ads — visibilidade sobre ml_ads_* (não é F12 completo)',
    content:  `**F11 E5 — Ads Visibility** mostra performance dos Product Ads / Brand Ads / Display Ads do seller sem precisar abrir o painel do ML. Camada **só de leitura** sobre o módulo \`ml-ads\` que já existe e já sincroniza diariamente as tabelas \`ml_ads_campaigns\` e \`ml_ads_reports\`.

**ESCOPO IMPORTANTE:** não é F12 completo. Aqui mostra. Pra **editar bids, recomendar budget, ou gerenciar campanhas** é módulo separado futuro (F12). Esta sprint só consome o dado que já existe.

**4 KPI cards 7d:**
- **Gasto** (vermelho) + delta vs 7d anteriores
- **Receita** (verde) + delta vs 7d anteriores
- **ACOS** (verde ≤15% / amarelo 15–30% / vermelho >30%) — limite configurável em \`ml_ads_summary.acos_threshold\` (default 30%)
- **ROAS** — multiplicador de retorno por R$ investido (>3x = healthy)

**2ª linha:** cliques + CTR · impressões · campanhas vencendo (ROAS >3x) · campanhas perdendo dinheiro (ACOS > threshold) · campanhas ativas.

**Gráfico spend vs revenue 30d** — SVG inline 2 séries (receita verde sólida, gasto vermelho tracejado).

**Filtros** (toggle + chip bar): tipo de campanha (PADS / BADS / DISPLAY).

**Leaderboards 7d:**
- **Top 10 perdendo dinheiro** (ACOS desc) — ação imediata pro lojista pausar ou ajustar bid
- **Top 10 vencendo** (ROAS desc) — escalar budget aqui

**Multi-conta nota importante:** Ads é por \`advertiser_id\`, NÃO por \`seller_id\`. Não há vínculo persistido \`advertiser_id ↔ seller_id\`, então agregamos por \`organization_id\`. Vazzo tem 2 advertisers (636197 + 2157277) cobertos por 1 ml_ads_summary row. UI executive aggregate puxa do snapshots[0] (não soma cross-account pra evitar duplicação).

**Coverage alert:** se \`ml_ads_campaigns\` não tem rows pra org, mostra "Conecte Product Ads pra ver mais dados". Quando o módulo ml-ads detectar via OAuth, KPIs aparecem automaticamente.

**Endpoints (backend):**
- \`GET /executive/ads\` — summary org-level
- \`GET /executive/ads/leaderboard?kind=winners|losers&limit=10\`
- \`GET /executive/ads/chart?days=30\` — série temporal
- \`POST /executive/ads/refresh\` — manual (sem chamadas ML — só re-agrega Postgres)

**Tabela cache:** \`ml_ads_summary\` (PK organization_id, refresh hourly em \`:37\`).

**Performance Vazzo 7d em prod (2026-05-11):** R$ 1.576 spend → R$ 11.538 revenue · ACOS 13.7% · ROAS 7.32x · 31 campanhas ativas · 11 perdendo dinheiro · 14 vencendo.`,
    tags: ['executive-dashboard', 'ads', 'acos', 'roas', 'product-ads', 'visibility'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// F1-F5 (2026-05-14) — Importer de planilha + Operação de Cadastro
// ════════════════════════════════════════════════════════════════════════

const CADASTRO_OPS_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/produtos/importar'],
    category: 'catalogo',
    title:    'Importar planilha de produtos (cadastro em massa)',
    content: `**Upload de planilha CSV/XLSX pra cadastrar produtos em lote.**

**Como funciona** (idempotente por SKU):
1. Arraste a planilha (.xlsx/.xls/.csv até 10MB) ou clique pra selecionar
2. Sistema faz **dry-run**: mostra preview com quantos serão cadastrados vs. quantos já existem (pulados)
3. Confirma → cadastra apenas SKUs novos. Marca cada produto novo com tag **cadastro_pendente** + \`catalog_status='incomplete'\`

**Colunas reconhecidas** (case-insensitive, sem acento):
- **Obrigatórias**: SKU/Código + Nome
- Opcionais: Marca, GTIN/EAN, Categoria, Custo, Preço, Peso, Largura, Comprimento, Altura, NCM, Estoque, Descrição
- Variantes aceitas: "Cod", "Cód", "Referência", "EAN GTIN", "Preço Venda" etc.

**Boas práticas**:
- Baixe o **template oficial** (botão no header) pra garantir cabeçalhos corretos
- SKU duplicado dentro da própria planilha = erro na linha (apenas 1 é cadastrado)
- Histórico de imports fica em \`product_import_batches\` (botão "Histórico")

**Próximo passo**: produtos novos aparecem em \`/dashboard/produtos?quick_filter=cadastro_pendente\`. Gestor pode despachar pro operador via \`/dashboard/produtos/operacao-cadastro\`.

**Endpoint**: \`POST /products/import\` (multipart/form-data, FileInterceptor)`,
    tags: ['import', 'upload', 'planilha', 'xlsx', 'csv', 'cadastro_pendente', 'sku', 'bulk'],
  },
  {
    routes:   ['/dashboard/produtos/operacao-cadastro'],
    category: 'catalogo',
    title:    'Operação de Cadastro — gestor despacha produtos pendentes pro operador',
    content: `**Tela do gestor pra despachar tarefas de cadastro pro operador (Active CRM).**

**Fluxo completo**:
1. **Aba "Pendentes"** — lista produtos com tag \`cadastro_pendente\` (vindos do importer ou que perderam dado essencial)
2. Sistema mostra **breakdown de campos faltando** (top 12 mais frequentes — ex: "Custo: 47 produtos", "GTIN: 32 produtos")
3. Gestor seleciona produtos via checkbox (até 100 por dispatch) + clica "Despachar pra operador"
4. Modal pede: **UUID do operador** (user no Active), **pipeline_id + stage_id** (funil "Operação de Cadastro"), prazo, prioridade, notas
5. Backend chama \`activeBridge.createCampaignCard()\` 1× por produto → **cria 1 card no kanban Active** com task + missing_fields no metadata
6. **Idempotência**: \`dedup_key = 'product_cadastro:<product_id>'\` — não duplica cards do mesmo produto

**Aba "Despachados"** — auditoria local em \`product_operator_assignments\` (status: open / in_progress / completed / cancelled)

**Critério "apto a anunciar"** (definição em \`ProductsCompletenessService\`):
- **Universal**: sku, name, brand, cost_price, my_price, weight_kg, dimensões, ≥1 foto, description ≥80 chars, category_ml_id, ml_title
- **ML-categoria dinâmica**: pega \`tags.required\` de \`/categories/{id}/attributes\` do ML (cache 7d em \`ml_category_attributes\`) e valida \`product.attributes[attr_id]\`
- Se tudo OK → remove tag \`cadastro_pendente\` automaticamente (catalog_status = 'ready')

**Cron diário 8h BRT**: re-avalia completeness de todo org com pendentes; emite \`alert_signal\` categoria \`catalog_incomplete\` se ainda houver (severidade escala com count).

**Callback reverso**: quando operador completa task no Active → Active chama \`POST /products/cadastro-callback\` no SaaS → assignment vira completed + produto re-avaliado.

**Config necessária** (env Railway SaaS):
- \`ACTIVE_AUTOMATION_BRIDGE_URL\` + \`ACTIVE_AUTOMATION_BRIDGE_SECRET\`
- Pipeline + stage criados manualmente no Active (template "operacao_cadastro" disponível)

**Endpoints**:
- \`GET /products/completeness-summary\` — KPIs + sample (até 500)
- \`POST /products/dispatch-to-operator\` — body: { product_ids[], operator_user_id, pipeline_id, stage_id, due_date, task_priority, notes }
- \`GET /products/operator-assignments?status=open\` — lista assignments
- \`POST /products/cadastro-callback\` — webhook do Active (auth shared secret)`,
    tags: ['operacao_cadastro', 'kanban', 'active', 'crm', 'dispatch', 'operador', 'task', 'pipeline', 'completeness'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// e-Click Radar IA — inteligência de mercado (MVP 1 + Motor 2)
// ════════════════════════════════════════════════════════════════════════

const RADAR_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/radar'],
    category: 'radar',
    title:    'e-Click Radar IA — watchlist de concorrentes e o que mudou',
    content: `**Radar de mercado centrado no seu produto de catálogo.** Acompanha
todas as ofertas de um mesmo produto no Mercado Livre — a sua e as dos
concorrentes — e detecta mudanças automaticamente.

**Por que catálogo, não anúncio avulso**: o Radar gira em torno do **produto de
catálogo** (a ficha única do ML, ex: \`MLB-PROD-123\`). Várias ofertas disputam o
mesmo produto; o Radar agrupa todas elas e compara preço, frete, logística e
reputação do vendedor lado a lado.

**A tela (Tela 1 — lista)**:
- **KPI strip** no topo: produtos monitorados, ofertas no total, quantos você
  está na ponta de preço, demanda de mercado estimada
- **Tabela ordenável** (clique no cabeçalho pra ordenar) — são 164+ produtos,
  por isso é tabela e não grade de cards. Colunas: produto, nº de ofertas, seu
  preço vs. menor preço, **Demanda** (estimada — ver Tela 2), eventos recentes
- **"O que mudou"** — painel consolidado dos eventos da org inteira: quedas de
  preço, novo concorrente, você perdeu/voltou à ponta de preço, mudança de frete
- Clique numa linha → abre a **Tela 2** (detalhe do produto)

**De onde vem o dado**: um coletor roda no \`eclick-workers\` 1×/dia. Ele lê
dados **públicos** do ML (ofertas do produto, visitas, perfil do vendedor) — não
existe API que entregue a venda real do concorrente, então a parte de demanda é
**estimada** (explicado na Tela 2). Há também uma rodada de **descoberta**
semanal que amplia a watchlist lendo o seu próprio catálogo.

**Eventos — severidade**:
- \`queda_preco\` / \`alta_preco\` — concorrente mexeu no preço
- \`mudanca_menor_preco\` — mudou quem está na ponta de preço. É **atenção** por
  padrão; vira **crítico** só quando o concorrente te corta o preço de forma
  agressiva (≥10% abaixo)
- \`novo_concorrente\` / \`saiu_concorrente\` — entrou/saiu oferta do conjunto
- \`mudanca_frete\` — frete ou tipo de logística mudou

A 1ª vez que um produto é coletado vira **baseline silencioso** — não dispara
enxurrada de \`novo_concorrente\`.

**Endpoints**: \`GET /radar/products\`, \`GET /radar/summary\`, \`GET /radar/events\``,
    tags: ['radar', 'concorrentes', 'watchlist', 'mercado', 'eventos', 'preco', 'inteligencia'],
  },
  {
    routes:   ['/dashboard/radar/[id]'],
    category: 'radar',
    title:    'Radar — detalhe do produto: ranking competitivo e demanda estimada',
    content: `**Tela 2 — raio-x de um produto de catálogo.**

**Ranking competitivo**: todas as ofertas ativas do produto, ordenadas por
preço. Cada linha traz vendedor (com cor da reputação), preço (verde + ▾ = menor
preço), **Demanda 30d estimada**, frete, logística e tipo de anúncio. A sua
oferta aparece destacada em ciano.

**Cruzamento de margem** (se o produto tiver custo cadastrado): custo interno vs.
menor preço do mercado vs. seu preço — mostra a margem bruta em cada cenário.
Margem bruta = (preço − custo) ÷ preço; **não** inclui tarifa ML, frete nem
imposto.

**Motor 2 — Demanda Estimada (o que o card "Como a demanda é estimada" explica)**:
- O ML **não expõe** a venda real do concorrente. O Radar **estima**:
  \`demanda ≈ visitas coletadas do anúncio × taxa de conversão\`
- A **conversão é calibrada no SEU dado real**: unidades vendidas ÷ visitas dos
  seus próprios anúncios monitorados, numa janela de 30 dias
- É calibrada **por categoria**; quando a categoria tem pouco dado, cai pra uma
  **taxa org-wide** (fallback). O card diz qual base foi usada ("calibrada por
  categoria" ou "por organização")
- **Confiança**: "Boa" quando há volume suficiente (≥200 visitas e ≥5 unidades
  na categoria), senão "Baixa" — e aí os números são ordem de grandeza, não
  exatos
- Por oferta a Tela 2 mostra \`visitas 30d\`, \`unidades estimadas\` e
  \`receita estimada\`

**Importante**: demanda estimada é **estimativa**, nunca a venda real do
concorrente. Use pra dimensionar o tamanho da disputa, não como número contábil.

**Gráficos**: histórico de preço (você + top 4 concorrentes) e visitas ao longo
do tempo.

**Calibração** roda 1×/dia no \`eclick-workers\` (passo do \`runDaily\`) e grava
em \`radar_conversion_calibration\`.

**Endpoints**: \`GET /radar/products/:id\`, \`GET /radar/products/:id/series\`,
\`GET /radar/products/:id/events\``,
    tags: ['radar', 'demanda', 'conversao', 'estimativa', 'ranking', 'concorrentes', 'visitas', 'margem', 'motor2'],
  },
  {
    routes:   ['/dashboard/radar/concorrentes', '/dashboard/radar/concorrentes/[productId]'],
    category: 'radar',
    title:    'Radar — Concorrentes Vinculados (anúncios não-catálogo)',
    content: `**A segunda metade do Radar.** O Radar de catálogo só cobre produtos
de catálogo ML. A maioria dos anúncios NÃO é catálogo — pra esses o ML não diz
quem concorre. Aqui **você vincula manualmente**: "meu produto X concorre com
estes anúncios de concorrente".

**Como vincular** (\`/dashboard/radar/concorrentes\`):
- Botão **"Vincular concorrente"** → escolha um produto seu + cole o **link do
  anúncio do concorrente** (a página MLB-... do Mercado Livre) + um apelido +
  o **preço dele**.
- Vincula-se ao **produto**, não ao anúncio: vale pra todos os seus anúncios
  daquele produto (conta principal, secundária, futuros).

**Por que o preço é você que informa**: o Mercado Livre **bloqueia** o preço de
anúncio de concorrente (a API responde 403, a busca está fechada, e a página
pública não traz o preço). Não é limitação do e-Click — é política do ML. Por
isso o preço é manual; atualize quando mudar (clique no preço no card pra
editar). O campo \`price_source\` já está pronto pra uma futura extensão do
Chrome automatizar isso.

**O que é automático**: **visitas** do concorrente (série diária — o ML libera
isso), **venda estimada** (visitas × sua conversão calibrada, Motor 2) e os
**movimentos** (preço subiu/baixou, visitas em alta/queda, concorrente mais
barato que você).

**Tela de comparação** (clique num produto monitorado):
- KPIs: seu preço, suas visitas 30d, suas **vendas reais** 30d, nº de concorrentes
- **Leitura do Radar** — insight de IA: o que os concorrentes estão fazendo e
  qual decisão considerar
- Gráficos de **preço** e **visitas** ao longo do tempo (você vs cada concorrente)
- Card por concorrente: preço (editável), preço vs você, visitas 30d, venda
  estimada 30d e pílulas de movimento. Dá pra **pausar** ou **remover** o vínculo.

**Importante**: venda estimada é estimativa (visitas × conversão), nunca a venda
real do concorrente — o ML não expõe esse dado. Use pra dimensionar a disputa.

**Coleta**: 1×/dia no eclick-workers. **Endpoints**: \`GET/POST/PATCH/DELETE
/radar/competitors/...\``,
    tags: ['radar', 'concorrentes', 'vinculados', 'preco', 'visitas', 'monitoramento', 'mercadolivre', 'comparacao'],
  },
]

// ════════════════════════════════════════════════════════════════════════
// Export consolidado
// ════════════════════════════════════════════════════════════════════════

const STOREFRONT_DESIGNER_ENTRIES: KbEntry[] = [
  {
    routes:   ['/dashboard/store/designer'],
    category: 'loja',
    title:    'Designer da Loja — visual da vitrine por IA',
    content: `**Cria o visual da sua loja própria (a vitrine pública em /loja/seu-slug) com ajuda de IA.**

**Como usar:**
- **Modelos de inspiração** — 4 estilos prontos (Tech Minimalista, Boutique Elegante, Vibrante, Clean Claro). Clique num para selecioná-lo.
- **Aplicar modelo selecionado** — usa o modelo escolhido direto, sem IA.
- **Gerar com IA** — descreva no campo de texto o estilo, as cores e a sensação que quer; a IA monta o design completo (tema, blocos e textos). Se um modelo estiver selecionado, ele vira o ponto de partida.
- **Inspiração visual** — na aba "Gerar com IA" também dá pra subir um print de uma loja de referência; a IA analisa a imagem (cores, fontes, estilo) e cria a sua loja no mesmo espírito.
- **Ajustar à mão** — a aba "Ajustar à mão" abre um editor manual: cores, fonte, cantos, densidade e quais blocos aparecem. Refina o que a IA gerou sem precisar de outro prompt.
- **Imagem do banner** — ainda na aba "Ajustar à mão", o botão "Gerar imagem do banner" cria com IA uma foto pro topo da loja, combinando com o estilo do design.
- O **preview ao lado** mostra a vitrine na hora. Não gostou? Ajuste o texto e gere de novo.

**O que a IA decide:** paleta de cores, tipografia, arredondamento, densidade, ordem dos blocos da home (cabeçalho, banner, grade de produtos, bloco "sobre", rodapé) e os textos.

**Boas práticas no prompt:**
- Diga o ramo da loja (joias, eletrônicos, moda fitness) — a IA ajusta o tom.
- Cite a cor de destaque e se quer tema claro ou escuro, se tiver preferência.
- Quanto mais específico o prompt, melhor o resultado.

**Importante:**
- A loja precisa estar com status Ativa (em Config da Loja) para ficar pública.
- Os produtos da vitrine vêm do catálogo: só aparecem os que estão prontos/publicados e com estoque maior que zero.
- Gerar um design substitui o anterior — é seguro, dá pra gerar quantas vezes quiser.`,
    tags: ['loja', 'storefront', 'design', 'vitrine', 'ia'],
  },
]

export const KB: KbEntry[] = [
  ...GENERAL_ENTRIES,
  ...CADASTRO_OPS_ENTRIES,
  ...CATALOG_ENTRIES,
  ...CREATIVE_ENTRIES,
  ...PUBLIC_ENTRIES,
  ...ATENDENTE_IA_ENTRIES,
  ...CRM_ENTRIES,
  ...COMPRAS_PRICING_ENTRIES,
  ...DROPSHIP_ENTRIES,
  ...FINANCEIRO_ENTRIES,
  ...SALES_ENTRIES,
  ...ADS_ENTRIES,
  ...ML_CAMPAIGNS_ENTRIES,
  ...ML_POSTSALE_INTELLIGENCE_ENTRIES,
  ...ML_LISTING_ENTRIES,
  ...EXECUTIVE_DASHBOARD_ENTRIES,
  ...RADAR_ENTRIES,
  ...OPS_ENTRIES,
  ...COPILOT_PAGE_ENTRIES,
  ...MULTI_ACCOUNT_ENTRIES,
  ...CONFIG_ENTRIES,
  ...STOREFRONT_DESIGNER_ENTRIES,
  // Catch-all sempre por último — só preenche o que sobrou do budget
  // após entries route-específicas
  ...CATCHALL_ENTRIES,
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
  // Suporta:
  //   '/x/[id]/y'     → '^/x/[^/]+/y$'           (segmento simples)
  //   '/x/[...rest]'  → '^/x(/.*)?$'              (catch-all, opcional)
  //   '/dashboard/*'  → '^/dashboard/[^/]+$'      (wildcard de 1 segmento)
  // Catch-all matchea o próprio prefixo + qualquer subpath. Útil pra
  // entries "globais" dentro do dashboard.
  let regexStr = '^'
  const segments = pattern.split('/')
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (i > 0) regexStr += '\\/' // separador (não para o 1º vazio)
    if (/^\[\.\.\.[^\]]+\]$/.test(seg)) {
      // catch-all: matchea zero+ segmentos. Reescreve o último '\\/'
      // pra ficar opcional (matcha tanto '/dashboard' quanto '/dashboard/x/y').
      regexStr = regexStr.slice(0, -2) + '(?:\\/.*)?'
      return new RegExp(regexStr + '$').test(pathname)
    }
    if (/^\[[^\]]+\]$/.test(seg)) {
      regexStr += '[^/]+'
    } else if (seg === '*') {
      regexStr += '[^/]+'
    } else {
      regexStr += seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  regexStr += '$'
  return new RegExp(regexStr).test(pathname)
}
