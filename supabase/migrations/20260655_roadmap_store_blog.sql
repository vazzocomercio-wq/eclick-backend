-- Sessão 2026-05-27 — Registra o épico Blog da Loja (multi-tenant) no roadmap.
-- Feature SaaS: cada loja ganha um blog GEO integrado à vitrine, ciente dos
-- produtos. Detalhes em memory/project_blog_geo.md (épico SB).
-- Phase F16: Blog da Loja — entregue (SB-1..SB-5).

DO $$
DECLARE
  vazzo_org uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833';
  v_phase_id uuid;
BEGIN
  INSERT INTO public.roadmap_phases (organization_id, num, label, sub, status, pct, sort_order)
  VALUES (
    vazzo_org, 'F16',
    'Blog da Loja (multi-tenant)',
    'Blog GEO integrado à vitrine de cada loja (/loja/[slug]/blog), com o tema da loja. A IA escreve artigos otimizados pra IA/Google que apresentam PRODUTOS REAIS da loja (bloco productGrid) → descoberta + venda. Pipeline IA cria → humano aprova → publica. Renderiza direto do SaaS (não usa Sanity). Toda loja do e-Click ganha.',
    'done', 95, 16
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_phase_id;
  IF v_phase_id IS NULL THEN
    SELECT id INTO v_phase_id FROM public.roadmap_phases WHERE organization_id = vazzo_org AND num = 'F16';
  END IF;
  DELETE FROM public.roadmap_items WHERE phase_id = v_phase_id;

  INSERT INTO public.roadmap_items (organization_id, phase_id, label, status, priority, notes) VALUES
  (vazzo_org, v_phase_id, 'SB-1 — Fundação: tabela store_blog_posts + módulo', 'done', 0,
    'Migration 20260654 store_blog_posts (org-scoped, GEO fields, pipeline review→published, scheduled_for, RLS via organization_members). Módulo store-blog no eclick-backend.'),
  (vazzo_org, v_phase_id, 'SB-2 — Motor de IA GEO ciente dos produtos', 'done', 0,
    'Gera artigo GEO via LlmService (jsonMode) que apresenta produtos reais da loja (productGrid com ids + featured_product_ids), capa + imagens inline (upload storefront-assets), ideação, lote. Smoke: 42 blocos, 3 productGrids com produtos reais.'),
  (vazzo_org, v_phase_id, 'SB-3 — Dashboard de gestão', 'done', 0,
    '/dashboard/loja/blog: gerar→revisar→publicar/agendar/arquivar + ideação + lote + polling. Item na sidebar (Blog da Loja).'),
  (vazzo_org, v_phase_id, 'SB-4 — Vitrine pública com tema da loja + GEO/SEO', 'done', 0,
    '/loja/[slug]/blog + /blog/[postSlug] com cores+fontes do Store Builder. Endpoints @Public (resolve slug→org). Renderer (block/image/productGrid/callout/stat/comparison) + productGrid linka produtos reais. JSON-LD BlogPosting+FAQPage. Smoke e2e: 6 productGrids, 19 produtos hidratados.'),
  (vazzo_org, v_phase_id, 'SB-5 — Worker de publicação agendada', 'done', 0,
    '@Cron */2min publica agendados vencidos (cross-org). Desligável via STORE_BLOG_PUBLISHER_DISABLED.'),
  (vazzo_org, v_phase_id, 'Revalidação on-demand da vitrine', 'planned', 3,
    'Hoje a vitrine usa ISR 60s (post aparece em ~1min). Adicionar revalidateTag on-demand pro post aparecer na hora ao publicar.'),
  (vazzo_org, v_phase_id, 'Voz da marca + Estúdio do blog da loja', 'planned', 4,
    'Portar voz da marca + prompts editáveis + base de conhecimento (como no blog da e-Click) pro blog da loja.'),
  (vazzo_org, v_phase_id, 'Calendário editorial + seletor de fonte do blog', 'planned', 5,
    'Calendário visual no dashboard + escolher a fonte de título do blog da loja (hoje herda o fontPair do tema).');
END $$;
