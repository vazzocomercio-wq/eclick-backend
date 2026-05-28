-- F18 F0.8 — Auditoria multi-tenant marketplace_connections.
--
-- ─────────────────────────────────────────────────────────────────────
-- ACHADO 1 — UNIQUE existente é scoped por org, não global.
--
-- Index existente:
--   idx_mp_connections_unique = UNIQUE (organization_id, platform,
--     COALESCE(shop_id::text, external_id, seller_id::text))
--
-- Significa que 2 orgs DIFERENTES podem teoricamente ter o MESMO shop_id
-- conectado. Na prática Shopee/ML shop_id é globalmente único — então NÃO
-- acontece, mas a integridade não está garantida no DB.
--
-- Risco: webhook handler (marketplace-webhooks.service.ts) faz lookup por
-- (platform=shopee, shop_id=N).maybeSingle() pra resolver org. Se 2 rows
-- match → maybeSingle() throw → webhook crasha → Shopee retry agressivo.
--
-- Mitigação: 3 UNIQUE INDEXes parciais (status='connected'). Permite
-- múltiplas rows desconectadas (history de re-conexão) mas só 1
-- 'connected' por (platform, identifier) globalmente.
--
-- Verifiquei duplicates antes de aplicar: 0 em shop_id, 0 em seller_id,
-- 0 em external_id. Caminho limpo.
--
-- ─────────────────────────────────────────────────────────────────────
-- ACHADO 2 — Pattern getAllConnections() leak (já corrigido em outro PR).
--
-- Memory feedback_multitenant_leak_patterns aponta o bug histórico:
-- MercadolivreService.getAllConnections() retornava ML connections de
-- TODAS as orgs; usado por getListings/getListingsCounts que recebiam
-- orgId mas IGNORAVAM. Fix: getAllConnectionsForOrg(orgId) hash 9bf9865.
--
-- Auditoria de marketplace.service.ts atual: TODOS os queries têm
-- .eq('organization_id', X) ou são by-PK (id=connectionId) — nenhum leak.
-- Não tem método "getAll" sem orgId. Safe.
--
-- ─────────────────────────────────────────────────────────────────────
-- ACHADO 3 — Webhook lookup é safe-by-design.
--
-- marketplace-webhooks.service.ts:71 faz .eq('platform','shopee')
-- .eq('shop_id', N).maybeSingle() — não trusta client (Shopee assina
-- via HMAC, validado em ShopeeAdapter.validateWebhookSignature ANTES do
-- lookup). Adicionamos .eq('status','connected') pra defensividade
-- (disconnected→reconnected races); update do código vem em commit
-- separado nesta fase.
--
-- ─────────────────────────────────────────────────────────────────────
-- Progresso F18: 5/37 done (F0.3 + F0.4 + F0.5 + F0.6 + F0.8) ≈ 14%.

-- ── UNIQUE global parcial (1 conexão 'connected' por id externo) ────
CREATE UNIQUE INDEX IF NOT EXISTS uniq_mp_connections_platform_shop_connected
  ON public.marketplace_connections (platform, shop_id)
  WHERE status = 'connected' AND shop_id IS NOT NULL;

COMMENT ON INDEX public.uniq_mp_connections_platform_shop_connected IS
  'F18 F0.8: força no DB que 1 shop_id (Shopee/TikTok) só pode estar conectado em UMA org por vez. Múltiplas rows desconectadas (history) seguem permitidas.';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_mp_connections_platform_seller_connected
  ON public.marketplace_connections (platform, seller_id)
  WHERE status = 'connected' AND seller_id IS NOT NULL;

COMMENT ON INDEX public.uniq_mp_connections_platform_seller_connected IS
  'F18 F0.8: força no DB que 1 seller_id (ML) só pode estar conectado em UMA org por vez.';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_mp_connections_platform_external_connected
  ON public.marketplace_connections (platform, external_id)
  WHERE status = 'connected' AND external_id IS NOT NULL;

COMMENT ON INDEX public.uniq_mp_connections_platform_external_connected IS
  'F18 F0.8: força no DB que 1 external_id (Magalu/Amazon) só pode estar conectado em UMA org por vez.';

-- ── Atualiza roadmap F18 ─────────────────────────────────────────────
DO $$
DECLARE
  vazzo_org  uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833';
  v_phase_id uuid;
BEGIN
  SELECT id INTO v_phase_id FROM public.roadmap_phases
   WHERE organization_id = vazzo_org AND num = 'F18';

  IF v_phase_id IS NULL THEN
    RAISE EXCEPTION 'Phase F18 não encontrada — aplicar 20260670 primeiro';
  END IF;

  UPDATE public.roadmap_items
     SET status = 'done', updated_at = now()
   WHERE phase_id = v_phase_id
     AND label LIKE 'F0.8 —%';

  UPDATE public.roadmap_phases
     SET pct = 14, updated_at = now()
   WHERE id = v_phase_id;
END $$;
