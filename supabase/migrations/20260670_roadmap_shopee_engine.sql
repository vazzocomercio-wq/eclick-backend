-- Sessão 2026-05-28 — Registra "e-Click Shopee Engine" no roadmap.
-- NÃO implementa código. Backend só ganha entradas em
-- roadmap_phases + roadmap_items pra Vazzo.
--
-- ============================================================
-- F18 — e-Click Shopee Engine
-- ============================================================
-- Plataforma de inteligência Shopee de DOIS LADOS:
--   • Lado Vendedor (mirror F7/F8/F10 do ML):
--       Listing Center, Quality Center, Campaign Center, Radar
--   • Lado Afiliado (superfície nova):
--       Discovery, Link Studio, Attribution Analytics, Content Studio
--   • A Ponte (matchmaker — diferencial real do mercado BR):
--       vendedor da base e-Click ↔ afiliado de nicho
--
-- Detalhes técnicos:
--   - Open Platform: partner.shopeemobile.com / openplatform.shopee.com.br
--     HMAC-SHA256, token 4h (worker renova), rate ~10 req/s/loja
--   - Affiliate API: affiliate.shopee.com.br (App ID/Secret separados)
--     SHA256(appId+timestamp+payload+secret), atribuição 7d, BR 19h-22h
--   - Image: armazenar image_id, NUNCA URL (CDN expira)
--   - Sandbox BR limitado → piloto em prod com loja Vazzo
--
-- Reusa do estado atual (mapeado pré-spec):
--   - MarketplaceAdapter base + Registry + ShopeeAdapter já implementado
--     (sign HMAC, BR host, 14d chunks, refresh token rotativo)
--   - public.marketplace_connections + crypto.util (AES-256-GCM)
--   - Active Social AI Studio (Reels/Live/Avatar) — destino, não duplicar
--   - public.products (hub do Estoque Unificado) — produto fica AQUI,
--     shopee.* apenas atributos/scores específicos
--
-- Tensões arquiteturais resolvidas no encaixe:
--   T1: shopee.products NÃO criar — hub é public.products. Schema
--       shopee.* fica só pra algo_score_breakdown / shop_metrics /
--       campaigns / affiliate_offers / match_offers
--   T2: módulo shopee-affiliate/ separado do marketplace/ (API distinta)
--   T3: Content Studio = reusa Active Social AI (injeta tracked_url)
--   T4: Matchmaker reusa Consent Ledger do e-Click Prospect (PF opt-in)
--   T5: métricas de loja não-API → fallback F12 Chrome Extension
--   T6: cyan #00E5FF como acento Engine; #EE4D2D em badges/logos Shopee
--
-- Roadmap completo: 5 fases (F0..F4) + Wave operacional.

DO $$
DECLARE
  vazzo_org uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833';
  v_phase_id uuid;
BEGIN
  -- ── Cria (ou reusa) a phase F18 ────────────────────────────────────
  INSERT INTO public.roadmap_phases (organization_id, num, label, sub, status, pct, sort_order)
  VALUES (
    vazzo_org,
    'F18',
    'e-Click Shopee Engine — Vendedor + Afiliado + Ponte',
    'Vertical Shopee da suíte e-Click ML Intelligence (lado vendedor espelhando F7/F8/F10) + superfície NOVA voltada a afiliados + matchmaker vendedor↔afiliado (diferencial de mercado). Identidade: cyan #00E5FF sobre #09090b. Reusa MarketplaceAdapter já existente + Active Social AI Studio. Modelar Algorithm Score em 4 pilares (relevância 40% / performance 30% / qualidade de loja 20% / preço+marketing 10%) — nunca uma nota única.',
    'planned',
    0,
    18
  )
  ON CONFLICT (organization_id, num) DO UPDATE
    SET label      = EXCLUDED.label,
        sub        = EXCLUDED.sub,
        sort_order = EXCLUDED.sort_order,
        updated_at = now()
  RETURNING id INTO v_phase_id;

  IF v_phase_id IS NULL THEN
    SELECT id INTO v_phase_id
    FROM public.roadmap_phases
    WHERE organization_id = vazzo_org AND num = 'F18';
  END IF;

  -- Limpa items antigos pra reaplicar idempotente
  DELETE FROM public.roadmap_items WHERE phase_id = v_phase_id;

  -- ────────────────────────────────────────────────────────────────────
  -- FASE 0 — FUNDAÇÃO (Hardening)
  -- Pré-requisito de tudo. ShopeeAdapter já existe; falta hardening
  -- production-grade: refresh, webhook, log, throttle.
  -- ────────────────────────────────────────────────────────────────────
  INSERT INTO public.roadmap_items (organization_id, phase_id, label, status, priority, notes) VALUES
  (vazzo_org, v_phase_id,
    'F0.1 — Validar OAuth Shopee em produção (loja Vazzo piloto)',
    'planned', 1,
    'Auditar env Railway (SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_REDIRECT_URI). Fluxo já implementado em /marketplace/shopee/auth-url + /marketplace/shopee/callback (MarketplaceController). Conectar loja Vazzo real → confirmar persistência em marketplace_connections (UNIQUE shop_id), refresh_token gravado, expires_at coerente com expire_in da Shopee (≈4h = 14400s). Smoke: ShopeeAdapter.listOrders 24h. Sandbox BR limitado — validação fim-a-fim só em produção.'),

  (vazzo_org, v_phase_id,
    'F0.2 — Refresh worker com rotação atômica (4h)',
    'planned', 1,
    'Shopee rotaciona refresh_token a CADA chamada — se transação não for atômica, race condition deixa orfão. Implementar: MarketplaceService.refreshAndPersist(connId) em transação Supabase (BEGIN/UPDATE/COMMIT); se Shopee retornar erro mantém tokens velhos. Worker @Cron a cada 30min varre marketplace_connections WHERE platform=shopee AND expires_at < now() + 1h. Reusa ShopeeAdapter.refreshToken (já implementado, usa expire_in não expires_in — gotcha confirmado).'),

  (vazzo_org, v_phase_id,
    'F0.3 — Webhook receiver /webhooks/shopee + HMAC Authorization',
    'planned', 1,
    'Shopee push (realtime > polling — regra obrigatória do projeto). Endpoint público (sem SupabaseAuthGuard) que valida Authorization header = HMAC-SHA256(partner_key, `${url}|${body}`). Push code 15 = NF-e BR-exclusive (atualização de status fiscal). Dispatcher por code → handler (order.status, item.update, escrow). Registrar URL no Shopee Partner Center pós-deploy. ⚠️ host BR sandbox não existe — testar em prod com loja Vazzo + log verbose primeiras 2 semanas.'),

  (vazzo_org, v_phase_id,
    'F0.4 — Tabela marketplace_webhook_events (log/auditoria)',
    'planned', 1,
    'CREATE TABLE marketplace_webhook_events (id, platform, received_at, push_code, signature_valid bool, body jsonb, processed_at, processor_error). Index (platform, received_at DESC). Persistir ANTES de processar (idempotência por (platform, push_id)). Útil pra debug das primeiras semanas + replay manual. Mantém payload 30d. RLS org-scoped (FK via shop_id → marketplace_connections.organization_id).'),

  (vazzo_org, v_phase_id,
    'F0.5 — Estender MarketplaceAdapter base com 8 métodos novos',
    'planned', 1,
    'Hoje: listOrders/getOrderDetail/extractBuyerBilling/refreshToken. Adicionar (signatures + abstract): listProducts(conn, cursor), updateStock(conn, itemId, modelId, qty), updatePrice(conn, itemId, modelId, price), shipOrder(conn, orderSn, package), requestShippingLabel(conn, orderSn), getShippingLabel(conn, orderSn), getEscrowDetail(conn, orderSn), validateWebhookSignature(headers, rawBody, secret). ML/Magalu adapters: throw NotImplementedException inicialmente (incremental). ShopeeAdapter implementa de verdade.'),

  (vazzo_org, v_phase_id,
    'F0.6 — Throttle por shop_id (~10 req/s) + retry com backoff',
    'planned', 2,
    'Shopee rate limit ~10 req/s POR LOJA. Implementar Bottleneck-like com Map<shop_id, queue>. Retry exponencial em 429/5xx (max 3 tentativas). Logar em marketplace_webhook_events.processor_error se esgotar. Reusa pattern do ml-ai-core (já tem throttle). Considerar Redis se cluster (Railway hoje é single-instance, in-memory OK).'),

  (vazzo_org, v_phase_id,
    'F0.7 — Sync inicial de produtos (image_id, NUNCA URLs)',
    'planned', 2,
    'GET /api/v2/product/get_item_list (paginação cursor) → /api/v2/product/get_item_base_info (batch 50) → /api/v2/product/get_model_list (variações). Armazenar image_id em shopee_product_attrs.image_ids[]; URL CDN expira em ~horas. Upsert idempotente por (shop_id, item_id). Espelhar product no public.products (hub do Estoque Unificado) + criar product_listings row platform=shopee. Cron @Cron a cada 6h.'),

  (vazzo_org, v_phase_id,
    'F0.8 — Multi-conta Shopee + auditoria de leak por orgId',
    'planned', 2,
    'marketplace_connections já tem UNIQUE (org, platform, shop_id). Garantir que MarketplaceService.getAdapterFor(orgId, shopId) NUNCA cai no fallback "última conta com updated_at mais recente" (bomba-relógio cross-tenant que afetou ML). Auditar todo caller: sellerId/shopId explícito. Memória de leaks (feedback_multitenant_leak_patterns) é regra OBRIGATÓRIA aqui também.');

  -- ────────────────────────────────────────────────────────────────────
  -- FASE 1 — LADO VENDEDOR (Algorithm Score + 4 pillares)
  -- Espelha F10 Listing / F7 Quality / F8 Campaign do ML.
  -- ────────────────────────────────────────────────────────────────────
  INSERT INTO public.roadmap_items (organization_id, phase_id, label, status, priority, notes) VALUES
  (vazzo_org, v_phase_id,
    'F1.1 — Shopee Algorithm Score (4 pilares 40/30/20/10) com issues acionáveis',
    'planned', 2,
    'Decompor cada anúncio em: Relevância 40% (keyword no título, completude de atributos obrigatórios por categoria, qualidade imagem/descrição); Performance 30% (sales velocity, CTR, conversão, boost de produto novo); Qualidade de loja 20% (vem de shop_metrics — chat/prep/late_ship/devolução/rating/penalty); Preço+marketing 10% (vs concorrente, uso de voucher/flash/ads). Fórmula: 0.40·R + 0.30·P + 0.20·Q + 0.10·PM. Cada pilar 0-100. Tabela shopee_algo_score_breakdown com issues JSONB (lista priorizada de correções). Recalculado a cada sync. Pattern espelha ml_listing_seo_scores (F10).'),

  (vazzo_org, v_phase_id,
    'F1.2 — Shopee Listing Center (espelha F10 ML Listing)',
    'planned', 2,
    'Tela /dashboard/catalogo/anuncios/shopee (hoje placeholder ChannelListingsPlaceholder). Lista todos os anúncios da loja com algo_score + breakdown radar (4 pilares). Card premium estilo Listing Center ML: badge cyan #00E5FF + lista de correções priorizadas + botão "Otimizar com IA" (reusa Copiloto Sonnet do GEO Optimizer). Categoria attrs obrigatórios renderizados como MlAttributesPanel (criar ShopeeAttributesPanel paralelo — não reusar direto, schemas diferentes).'),

  (vazzo_org, v_phase_id,
    'F1.3 — Shopee Quality Center (chat / prep / late ship / devolução)',
    'planned', 3,
    'Cockpit de saúde da loja: chat_response_rate, chat_response_time_min, prep_time_days, late_ship_rate, return_refund_rate, rating, penalty_points. Snapshot diário em shopee.shop_metrics. Semáforo + alerta pré-punição: penalty_points >= 6 = "ameaça" + WhatsApp founder + card no Inbox Active. Métricas SEM API → marcar como "via F12 Chrome Extension" (fallback planejado). Espelha F7 Quality ML.'),

  (vazzo_org, v_phase_id,
    'F1.4 — Shopee Campaign Center (voucher / flash sale / ads)',
    'planned', 3,
    'CRUD de voucher (codeless + por canal), flash sale (window + desconto), ads (boost de produto). Gate de margem: bloqueia campanha se margem pós-comissão < threshold (reusa motor de margem central do projeto). ROI calculado por campanha (revenue vs cost). Espelha F8 Campaign ML. Endpoints Shopee: /api/v2/voucher/*, /api/v2/discount/*, /api/v2/ads/*.'),

  (vazzo_org, v_phase_id,
    'F1.5 — Radar Shopee (concorrência + preço + tendência por busca)',
    'planned', 3,
    'Coletor de tendências da Shopee: produto em alta por categoria, preço médio do concorrente líder, % de vendedores com FBS (Frete Grátis Shopee). Tabela shopee.market_signals com upsert diário. Cross-link com Radar IA existente (módulo radar no eclick-active — mesmo padrão de Concorrentes Vinculados). Sinal "preço 8% acima do líder" = badge na Listing Center.'),

  (vazzo_org, v_phase_id,
    'F1.6 — Refator transversal: orders/stock/fulfillment via MarketplaceAdapterRegistry',
    'planned', 1,
    'Removendo 7 hardcodes ML mapeados pré-spec: orders.service.ts (source filter L120), stock.service.ts (channel fallback L360/L629), fulfillment-labels.service.ts (MercadolivreService direto L56/L88), ai-visibility/ml-publisher.service.ts (PUT hardcoded), creative-ml-publisher.service.ts (ML_BASE const), products.service.ts (ml_title/ml_listing_id select), sales-aggregator/orders-ingestion.service.ts (hardcoded platform=mercadolivre L191/L851). Substituir por registry.get(platform). Sem isso, Shopee fica isolada em ilha (anti-objetivo).'),

  (vazzo_org, v_phase_id,
    'F1.7 — IA Criativo Shopee (publish via Copiloto + algo_score guard)',
    'planned', 3,
    'Estender módulo creative/ pra publicar no Shopee. Hoje: creative-ml-publisher.service.ts hardcoded ML. Criar creative-shopee-publisher.service.ts + interface CreativePublisher. IA gera título/descrição/imagens → algo_score em dry-run → se score pilar Relevância < 70, sugere correções ANTES de publicar. Reusa pipeline existente (vision/listing/image/video) + adiciona destino Shopee.');

  -- ────────────────────────────────────────────────────────────────────
  -- FASE 2 — LADO AFILIADO (Shopee Affiliate API — superfície NOVA)
  -- ────────────────────────────────────────────────────────────────────
  INSERT INTO public.roadmap_items (organization_id, phase_id, label, status, priority, notes) VALUES
  (vazzo_org, v_phase_id,
    'F2.1 — Módulo shopee-affiliate/ paralelo a marketplace/',
    'planned', 3,
    'Affiliate API tem auth/escopo/payload distintos do Open Platform vendedor. NÃO espremer no MarketplaceAdapter — criar módulo NestJS independente: ShopeeAffiliateController, ShopeeAffiliateService, ShopeeAffiliateAdapter. Cadastro App ID + App Secret em affiliate.shopee.com.br → grava em shopee.affiliate_connections (org, app_id, app_secret encrypted, affiliate_id). Status active|expired. Diferenciar conceitualmente de public.affiliates (programa de afiliados da Loja Própria — schema 20260615, totalmente outro produto).'),

  (vazzo_org, v_phase_id,
    'F2.2 — Assinatura SHA256(appId+timestamp+payload+secret) + endpoints',
    'planned', 3,
    'Base string Shopee Affiliate é diferente do Open Platform: SHA256(appId + timestamp + payload + secret). Endpoints: GET /offers (ofertas com comissão pré-computada), POST /links/generate (link rastreado por sub_id), GET /reports/conversions (por sub_id + status pending/confirmed). Throttle conservador. Documentar diferenças no copilot.kb pro próximo dev não confundir.'),

  (vazzo_org, v_phase_id,
    'F2.3 — Affiliate Discovery Engine (ingestion + Opportunity Score)',
    'planned', 3,
    'Worker @Cron 1h puxa ofertas via /offers → shopee.affiliate_offers (item_id, shop_id, name, category, price, commission_rate, rating, sales_volume, seller_score, conv_estimate). Calcula opportunity_score = w1·commission_normalizada + w2·conv_estimate + w3·seller_score + w4·trend (sinal Radar). Filtro de saída: rating<4.5 OU seller reputação baixa = OUT (devolução cancela comissão = trap). Comissão pura engana — ranking por OPPORTUNITY, não COMMISSION.'),

  (vazzo_org, v_phase_id,
    'F2.4 — Link Studio (sub_id por canal + QR + encurtador)',
    'planned', 3,
    'Tela /dashboard/shopee/afiliado-discovery: grade de ofertas ordenadas por opportunity_score, filtros nicho+comissão min. Botão "Gerar link" → POST /links/generate com sub_id = `{org_short}_{channel}_{timestamp}`. Grava em shopee.affiliate_links. QR code gerado (lib qrcode), URL encurtada (eclick.app.br/s/{hash} → 302). Canais: whatsapp, instagram, tiktok, shopee_video, shopee_live, blog.'),

  (vazzo_org, v_phase_id,
    'F2.5 — Attribution Analytics (pending → confirmed, janela 7d)',
    'planned', 3,
    'Atribuição Shopee = cookie 7d. Estado dual: pending (clique → conversão) | confirmed (pós-entrega + pagamento) | cancelled. Worker reconciliação 30min varre conversions pending mais velhas que ETA entrega → poll /reports/conversions e flip pra confirmed/cancelled. Tela /dashboard/shopee/comissoes: gráfico pending vs confirmed por canal, ROI por sub_id (revenue / custo de mídia), receita por nicho. Saque mínimo R$30 (regra Shopee BR).'),

  (vazzo_org, v_phase_id,
    'F2.6 — Content Studio integrado (NÃO duplica — usa Active)',
    'planned', 4,
    'Active Social AI Studio (/social no eclick-active) já tem geração de Reels/Live/posts/Avatar D-ID. Plug Shopee Video + Shopee Live como destinos novos (espelha pattern IG Reels). Inject tracked_url (link afiliado F2.4) no roteiro IA: Copiloto Sonnet recebe contexto "produto afiliado X, comissão Y%, canal Z" e gera copy + CTA com link. Scheduler já existe — adicionar prefer 19h-22h BRT (pico BR de conversão).');

  -- ────────────────────────────────────────────────────────────────────
  -- FASE 3 — CAMPANHAS + CONTEÚDO (Vendedor que vira marketing)
  -- ────────────────────────────────────────────────────────────────────
  INSERT INTO public.roadmap_items (organization_id, phase_id, label, status, priority, notes) VALUES
  (vazzo_org, v_phase_id,
    'F3.1 — Campaign Center com ROI gate (margem mínima pós-comissão)',
    'planned', 4,
    'Lojista cria voucher/flash/ads com slider de desconto. Calculadora live: revenue projetado − comissão Shopee − desconto − comissão afiliado (se houver) = margem líquida. Bloqueia se margem < threshold da organização (organizations.min_campaign_margin_pct). Reusa motor de margem central (margin.ts comum entre backend e frontend).'),

  (vazzo_org, v_phase_id,
    'F3.2 — Shopee Video / Live: agendamento + injeção de link',
    'planned', 4,
    'Active Social AI scheduler ganha destino Shopee Video e Shopee Live. Conta da Shopee tem upload via Partner Center API (publish endpoint diferente do Open Platform regular). Cron prioriza 19h-22h BRT pra publish. Telemetria: views, CTR, conversão linkada via sub_id da F2.4.'),

  (vazzo_org, v_phase_id,
    'F3.3 — Sinal de conteúdo IA para vendedor (não só afiliado)',
    'planned', 4,
    'Vendedor da Vazzo também posta no Shopee Video sobre seus PRÓPRIOS produtos (não só afiliados promovem). Copiloto Sonnet sugere roteiros sazonais (clima, datas comemorativas, BFCM Shopee 10.10/11.11/12.12). Reusa Estúdio de Estilos do Active (eclick-active migrations 077/078).');

  -- ────────────────────────────────────────────────────────────────────
  -- FASE 4 — A PONTE (Matchmaker — DIFERENCIAL DE MERCADO)
  -- O movimento que ninguém no Brasil faz integrado.
  -- ────────────────────────────────────────────────────────────────────
  INSERT INTO public.roadmap_items (organization_id, phase_id, label, status, priority, notes) VALUES
  (vazzo_org, v_phase_id,
    'F4.1 — Schema shopee.match_offers + match_score',
    'planned', 5,
    'CREATE TABLE shopee.match_offers (id, org_id, seller_shop_id, item_id, proposed_commission_pct, affiliate_profile JSONB (nicho/alcance/canais/historico), match_score smallint, status open|accepted|declined|active|paused). match_score = fit produto↔afiliado: similaridade nicho, alcance proporcional, histórico de conversão do afiliado na categoria. pgvector pra embedding similarity (mesma stack que e-Click Prospect usa).'),

  (vazzo_org, v_phase_id,
    'F4.2 — UI marketplace dois-lados (vendedor / afiliado)',
    'planned', 5,
    'Tela /dashboard/shopee/matchmaker (vendedor): "afiliados que combinam com seu catálogo", grade com match_score + propor comissão custom. Tela /dashboard/shopee/oportunidades (afiliado): "vendedores te procuraram", aceitar/recusar + sub_id auto-gerado. Estilo marketplace clean (não LinkedIn, mais Upwork pra vendas).'),

  (vazzo_org, v_phase_id,
    'F4.3 — Consent gate via e-Click Prospect (PF opt-in obrigatório)',
    'planned', 5,
    'Afiliados são predominantemente PF. e-Click Prospect (project_lead_prospection) já cravou: PF SÓ opt-in/inbound, proibido raspar. Matchmaker reusa Consent Ledger (prospect.consents). Afiliado entra na base via inbound (cadastro próprio em /shopee/sou-afiliado) com consent explícito de aparecer no matchmaker + opt-in WhatsApp. Sem consent = não listável.'),

  (vazzo_org, v_phase_id,
    'F4.4 — Bridge cross-schema com active.contacts',
    'planned', 5,
    'Afiliado virou contato no CRM do Active assim que aceita match. View v_saas_shopee_affiliates expõe pro Active sem cópia (mesmo padrão das outras bridges saas↔active). Card em active.deals quando match vira venda. Ciclo medido em shopee.conversions (já planejado F2.5) → fechamento do funil.'),

  (vazzo_org, v_phase_id,
    'F4.5 — Métricas de Ponte (north star do diferencial)',
    'planned', 5,
    'Dashboard /dashboard/shopee/ponte-metrics (admin Vazzo). Métricas: nº de matches ativos, GMV gerado via afiliados DA PLATAFORMA (não Shopee genérica), tempo médio match→primeira venda, retention de afiliado após primeira venda. Esses números são a tese de "best/smartest Shopee integration no BR" que o user pediu.');

  -- ────────────────────────────────────────────────────────────────────
  -- WAVE — Hardening operacional (transversal a todas as fases)
  -- ────────────────────────────────────────────────────────────────────
  INSERT INTO public.roadmap_items (organization_id, phase_id, label, status, priority, notes) VALUES
  (vazzo_org, v_phase_id,
    'W.1 — Schema: produto fica em public.products (hub unificado), NÃO shopee.products',
    'planned', 6,
    'Decisão arquitetural T1. Estoque Unificado (épico entregue, project_estoque_unificado) cravou: produto é hub central em public.products + product_stock ledger + espelho em products.stock. Adicionar shopee.products quebra o hub. Schema shopee.* fica APENAS para: algo_score_breakdown, shop_metrics, campaigns, affiliate_offers, affiliate_links, conversions, match_offers, market_signals. Atributos por canal → shopee_product_attrs (ou JSONB em products.platform_data->shopee).'),

  (vazzo_org, v_phase_id,
    'W.2 — Identidade visual: cyan #00E5FF (Engine) + #EE4D2D (badges Shopee)',
    'planned', 6,
    'Cyan #00E5FF como acento das telas da Engine (chrome de páginas, dashboards, cards de score). Laranja oficial Shopee #EE4D2D mantém em badges/logos/placeholders (já está em /dashboard/catalogo/anuncios/shopee). Memória feedback_theme_system aplica: CSS vars em globals.css, não hardcode espalhado.'),

  (vazzo_org, v_phase_id,
    'W.3 — Copilot KB atualizada por sprint (regra OBRIGATÓRIA)',
    'planned', 6,
    'feedback_copilot_kb_per_sprint: toda sprint que cria/modifica feature visível DEVE atualizar src/modules/copilot/copilot.kb.ts no MESMO commit. Entries com routes[] patterns Next.js + content markdown rico (como usar + valor + gotchas). Cobertura: cada item dessa fase F18 vira entry no KB.'),

  (vazzo_org, v_phase_id,
    'W.4 — i18n obrigatório (pt/en/zh — SaaS adotou next-intl)',
    'planned', 6,
    'feedback_active_i18n + project_saas_i18n: textos novos vão em messages/pt.json + en/zh (Active e SaaS adotaram next-intl). Namespace sugerido: shopee.* (pra Engine), shopee_affiliate.* (pra afiliado). Nomes de produto seguem em PT (loja BR), UI traduz.'),

  (vazzo_org, v_phase_id,
    'W.5 — Sandbox BR não existe — piloto direto em prod com Vazzo',
    'planned', 6,
    'Shopee Open Platform BR: sandbox limitado, várias features só em prod. Estratégia: loja Vazzo é piloto + canary. Toda mudança nova roda 24-48h só na conta dela ANTES de habilitar pra outras orgs. Feature flag por organization_id em organizations.feature_flags JSONB (shopee_engine_enabled bool). Sem essa salvaguarda, mudança ruim quebra todos os clientes simultaneamente.'),

  (vazzo_org, v_phase_id,
    'W.6 — Memory correction: TikTok Shop tem FUNDAÇÃO (creds + scripts), NÃO módulo',
    'planned', 6,
    'Memory project_tiktok_shop_integration está enganosa: tabela tiktok_shop_credentials existe + loja Vazzo (BRLCXULW9W) conectada + scripts tts-*.mjs funcionais (HMAC 202309), MAS não tem módulo NestJS estruturado. Investigação separada (criar F19 — TikTok Shop Engine paralelo a F18 se user aprovar). Sem isso, próxima sessão re-implementa do zero.'),

  (vazzo_org, v_phase_id,
    'W.7 — Aprovação Affiliate API: aplicar CEDO (gargalo de cronograma)',
    'planned', 6,
    'affiliate.shopee.com.br exige aprovação manual da equipe Shopee (1-3 semanas no histórico). Aplicar JÁ — sem App ID/Secret aprovado, Fase 2 inteira fica bloqueada. Não esperar Fase 0/1 fecharem.'),

  (vazzo_org, v_phase_id,
    'W.8 — Inbox Shopee (chat) = fallback F12 Chrome Extension',
    'planned', 6,
    'Chat API da Shopee tem restrições agressivas (whitelist pesada). Decisão: scraping browser-side via F12 Chrome Extension (já roadmap), NÃO API. Active continua sendo hub único de conversas (feedback_active_is_inbox_hub): extensão captura msg → POST /webhooks/shopee-chat (e-Click) → bridge pro inbox do Active. Sem novo Inbox paralelo.');

END $$;
