-- Sessão 2026-05-14 — Registra projeto da extensão Chrome no roadmap
-- pra fazer depois. NÃO implementa nada agora. Backend só ganha
-- entradas em roadmap_phases + roadmap_items pra Vazzo.
--
-- Detalhes completos da arquitetura em
--   memory/project_chrome_extension.md
--
-- Phase F12: eClick Extension — Power Tools no Marketplace
-- 6 ondas core (E1-E6) + 8 melhorias (M1-M8) = 14 items.

DO $$
DECLARE
  vazzo_org uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833';
  v_phase_id uuid;
BEGIN
  -- Cria (ou reusa) a phase F12
  INSERT INTO public.roadmap_phases (organization_id, num, label, sub, status, pct, sort_order)
  VALUES (
    vazzo_org,
    'F12',
    'eClick Extension — Power Tools no Marketplace',
    'Extensão Chrome MV3 (manifest v3) com features tipo AvantPro, mas com nosso jeitinho: dados REAIS (cost_price, sale_fee, conversão) em vez de estimativa, deeplinks pro eclick, captura 1-clique de concorrente. Backend já tem 90% dos dados; falta o conector.',
    'planned',
    0,
    12
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_phase_id;

  -- Se já existia, busca id
  IF v_phase_id IS NULL THEN
    SELECT id INTO v_phase_id
    FROM public.roadmap_phases
    WHERE organization_id = vazzo_org AND num = 'F12';
  END IF;

  -- Limpa items antigos dessa phase pra reaplicar idempotente
  DELETE FROM public.roadmap_items WHERE phase_id = v_phase_id;

  -- ── 6 ONDAS CORE ─────────────────────────────────────────────────────
  INSERT INTO public.roadmap_items (organization_id, phase_id, label, status, priority, notes) VALUES
  (vazzo_org, v_phase_id,
    'E1 — Setup + Auth + Popup base',
    'planned', 1,
    'Repo novo eclick-chrome-extension. Stack: Vite + @crxjs/vite-plugin + TS + React + Tailwind. Manifest V3 com host_permissions: mercadolivre.com.br, mercadolibre.com, app.eclick.app.br, eclick-backend-production-2a87.up.railway.app. Auth via cookie share: popup abre app.eclick.app.br/extension/handshake (nova rota Next) que lê localStorage[sb-auth-token] e postMessage de volta pra extension; token guardado em chrome.storage.local. Helper getAuthToken() exposto pro background + content scripts. Popup base mostra status "Logado como X" + botão "Conectar" se não tem token. Estrutura: src/popup/, src/content/, src/background/, src/shared/.'),
  (vazzo_org, v_phase_id,
    'E2 — Content script: badge + overlay margem real (NOSSO diferencial)',
    'planned', 1,
    'Content script em pages ML (item detail + search results + my listings). Detecta MLB IDs no DOM. Pra cada item: fetch GET /extension/product-by-ml-id/:itemId no nosso backend → retorna {is_ours, our_product_id, cost_price, my_price, sale_fee_real, margin_pct, visits_30d, conversion_30d, units_sold_30d, profit_30d_estimate}. Se is_ours=true: injeta badge cyan "eclick" + tooltip rico com 4 KPIs reais. Se is_ours=false: badge cinza "+ Adicionar" (encaminha pra E4). NUNCA mexe no DOM original do ML — só anexa elements com data-eclick-injected pra cleanup fácil.'),
  (vazzo_org, v_phase_id,
    'E3 — Calculadora de preço final flutuante (dados reais)',
    'planned', 2,
    'Painel flutuante draggable (chrome.storage salva posição). Inputs: preço de venda, custo (auto-preenche com cost_price se anúncio for nosso), tarifa categoria (auto via /categories/{id}/sale_fee_amount do ML), frete grátis sim/não, MWPP sim/não, tipo Clássico/Premium. Output: margem absoluta + %, lucro estimado, preço mínimo pra margem alvo. Backend endpoint /extension/calculator que centraliza fórmula (eclick-backend já calcula isso em vários lugares — extrair pra service único).'),
  (vazzo_org, v_phase_id,
    'E4 — Captura de concorrente em 1 clique',
    'planned', 2,
    'Botão "Capturar pro catálogo" injetado em página de anúncio ML que NÃO é nosso. Click → content script extrai: título, preço, fotos (urls), descrição, atributos, categoria_id, GTIN, vendedor. POST /extension/scrape-and-import no backend → cria products row com status=draft + tag=cadastro_pendente + tag=capturado_concorrente + source_listing_url. Idempotente por (org_id, source_listing_url). Aparece em /produtos/operacao-cadastro pra completar dados manualmente. Limite: 50 capturas/dia/org pra evitar abuso.'),
  (vazzo_org, v_phase_id,
    'E5 — Deeplinks: atalhos pro eclick',
    'planned', 3,
    '3 botões no overlay E2 + items no popup: (a) "Abrir no eclick" → app.eclick.app.br/dashboard/produtos/<our_product_id>/editar; (b) "Operação cadastro" → /produtos/operacao-cadastro?product_id=X; (c) "Criar campanha ML" → /dashboard/ml-campaigns/nova?listing=<mlb_id>. Botões só aparecem se contextualmente fazem sentido (ex: "Operação cadastro" só se tag=cadastro_pendente). Atalho de teclado: Ctrl+Shift+E abre o produto correspondente no eclick.'),
  (vazzo_org, v_phase_id,
    'E6 — Popup dashboard: KPIs do dia + alertas',
    'planned', 3,
    'Popup ganha tabs: Hoje (vendas do dia + ticket médio + lucro estimado), Alertas (top 5 do /alerts ou intelligence:alert via SSE), Pendentes (count cadastro_pendente + link operação), Atalhos (botões pras telas principais). Polling 30s do background worker pra manter dados frescos sem fetch agressivo. Reaproveita endpoints existentes: /dashboard/summary, /alerts, /products/completeness-summary.');

  -- ── 8 MELHORIAS ("nosso jeitinho") ───────────────────────────────────
  INSERT INTO public.roadmap_items (organization_id, phase_id, label, status, priority, notes) VALUES
  (vazzo_org, v_phase_id,
    'M1 — Trending Products inline (reuso Intelligence Hub + Visits Scanner F10)',
    'planned', 4,
    'No popup tab "Tendências": lista top 50 produtos em alta nas categorias que vendemos (visits 30d + conversion). Fonte: ml-intelligence/visits-scanner que JÁ roda diário. Item clicável → abre página do anúncio ML em nova aba. Substitui o "Tendências" do AvantPro com dado mais relevante (filtrado pelas nossas categorias, não genérico).'),
  (vazzo_org, v_phase_id,
    'M2 — Comparador: concorrente vs nosso (mesma SKU/GTIN)',
    'planned', 4,
    'Quando content script detecta MLB do concorrente, se houver match GTIN/SKU com produto nosso, overlay ganha card "VS" mostrando: nosso preço vs deles, nossa margem (real) vs estimada deles, visits 30d ambos, badge "Você está X% mais caro/barato". Match via products.gtin → tabela ml_competitors_observed (criar) + view materializada update diária.'),
  (vazzo_org, v_phase_id,
    'M3 — Quick price/stock edit inline (sem sair do ML)',
    'planned', 4,
    'No overlay E2 (anúncio nosso), botão "Editar" abre mini-form: novo preço, novo estoque, novo título — PATCH /products/:id direto. Após confirmar, sincroniza com ML via ml-listing-center bulk action endpoint (já existe). Conveniência: ver o anúncio do concorrente, ajustar nosso preço pra competir, tudo numa aba só.'),
  (vazzo_org, v_phase_id,
    'M4 — Notifications nativas pra alertas críticos',
    'planned', 5,
    'Background worker conecta no nosso Socket.IO + escuta `intelligence:alert`. Severidade critical/high → chrome.notifications.create() com link pro deeplink. Permission opt-in no popup. Útil pra: pedido novo (alarme suave), reputação caindo, claim aberto, stock-out crítico.'),
  (vazzo_org, v_phase_id,
    'M5 — Theme sync com app web (claro/escuro)',
    'planned', 5,
    'Lê preferência do localStorage do app web no handshake; injetar mesma CSS var --surface, --accent, etc. Tailwind dark mode class="dark". Atualiza em tempo real se user trocar tema no app.'),
  (vazzo_org, v_phase_id,
    'M6 — Atalhos de teclado globais',
    'planned', 5,
    'chrome.commands no manifest: Ctrl+Shift+K → abre popup; Ctrl+Shift+E → abre produto atual no eclick; Ctrl+Shift+C → captura concorrente. Configurável pelo user em chrome://extensions/shortcuts.'),
  (vazzo_org, v_phase_id,
    'M7 — Captura em massa na página de busca ML',
    'planned', 6,
    'Quando user está em mercadolivre.com.br/busca?as_word=X, content script lista os 50 resultados com checkboxes "+" e botão "Capturar selecionados" no overlay. Bulk POST /extension/scrape-and-import-bulk. Útil pra reconhecimento rápido de mercado.'),
  (vazzo_org, v_phase_id,
    'M8 — Suporte multi-conta ML (segue conta selecionada no app)',
    'planned', 6,
    'Quando user troca conta ML no AccountSelector do app web, extensão pega via handshake periódico. Todos endpoints backend passam a usar sellerId explícito (regra cross-projeto já documentada). Sem isso, sync de dados pode pegar conta errada em ambiente multi-conta da Vazzo.');

END $$;
