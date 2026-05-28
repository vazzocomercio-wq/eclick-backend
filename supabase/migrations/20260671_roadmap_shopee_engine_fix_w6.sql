-- Sessão 2026-05-28 — Correção do item W.6 da fase F18.
--
-- A migration 20260670 incluiu o W.6 com a afirmação errada:
--   "TikTok Shop tem FUNDAÇÃO (creds + scripts), NÃO módulo"
--
-- INVESTIGAÇÃO posterior provou o contrário: TikTok Shop está
-- COMPLETO em produção (origin/main):
--   • src/modules/tiktok-shop/ — 2220 linhas (service 1808 + controller
--     311 + cron + sign + module)
--   • 20+ endpoints: OAuth (auth-url/callback), webhook, status, shops,
--     orders (import/list), products (import/list), publish (categories/
--     attributes/recommend-category/preview/publish), listings (counts/
--     list/price/activate/deactivate/sync-stock)
--   • Integrado com StockModule (forwardRef) — TT-4a push catálogo→TikTok
--     e TT-4b PULL venda→baixa estoque mestre (GATEADO)
--   • Integrado com ChannelSettingsModule — TT-5b comissão TikTok pro
--     platform_fee em pedidos unificados
--   • Cron sync em tempo real + reconciliação (commit f53e4b1)
--   • Tabelas: public.tiktok_shop_credentials, tiktok_shop_orders,
--     tiktok_shop_products (loja Vazzo conectada 2026-05-27,
--     shop_id 7494393767194167186, seller Vazzo)
--   • Active bridge: active.v_saas_tiktok_products (migration 083 do
--     monorepo Active) + /bridge/tiktok-products endpoint
--   • 16+ commits TT-1 → TT-5b + TT-B (publish GEO optimization back)
--
-- Erro de investigação: o main worktree estava em
-- feat/fiscal-f2b-emit-nota (outra sessão fiscal) que foi branchada
-- ANTES do merge do tiktok-shop, então o ls não viu o dir. Memória
-- (project_tiktok_shop_integration) estava correta.
--
-- Esta migration substitui o W.6 por algo útil: REUSAR padrões do
-- tiktok-shop/ na construção do shopee-engine/.

DO $$
DECLARE
  vazzo_org uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833';
  v_phase_id uuid;
BEGIN
  SELECT id INTO v_phase_id
  FROM public.roadmap_phases
  WHERE organization_id = vazzo_org AND num = 'F18';

  IF v_phase_id IS NULL THEN
    RAISE EXCEPTION 'Phase F18 não encontrada — aplicar 20260670 primeiro';
  END IF;

  -- Atualiza W.6 in-place (label antigo continha "TikTok Shop tem FUNDAÇÃO")
  UPDATE public.roadmap_items
     SET label = 'W.6 — Reusar padrões do módulo tiktok-shop/ (já em prod) na Shopee Engine',
         notes = 'CORREÇÃO: investigação confirmou que tiktok-shop/ está completo (16+ commits TT-1 a TT-5b, 2220 linhas, 20+ endpoints OAuth/webhook/orders/products/publish/listings). Loja Vazzo conectada (shop_id 7494393767194167186) desde 2026-05-27. Esse módulo é o MELHOR template pra Shopee Engine: padrão sign-util.ts isolado, controller com endpoint POST /webhook público (sem guard), sync.cron com reconciliação, forwardRef(StockModule) pra integração bi-direcional, ChannelSettings pra fee/comissão, tabelas isoladas (tiktok_shop_credentials/orders/products) + bridge view pro Active (v_saas_tiktok_products). Reusar EXATAMENTE essa arquitetura pra Shopee — não inventar padrão novo. F0.5 (estender MarketplaceAdapter) e F0.3 (webhook) ficam mais simples copiando estrutura do tiktok-shop/.',
         updated_at = now()
   WHERE phase_id = v_phase_id
     AND label LIKE 'W.6%';

  IF NOT FOUND THEN
    RAISE WARNING 'W.6 não encontrado pra atualizar — inserindo novo';
    INSERT INTO public.roadmap_items (organization_id, phase_id, label, status, priority, notes)
    VALUES (
      vazzo_org, v_phase_id,
      'W.6 — Reusar padrões do módulo tiktok-shop/ (já em prod) na Shopee Engine',
      'planned', 6,
      'Módulo tiktok-shop/ é o melhor template pra Shopee. Reusar arquitetura: sign-util isolado, webhook público, sync cron, forwardRef StockModule, ChannelSettings pra fee, tabelas isoladas + bridge view pro Active.'
    );
  END IF;

END $$;
