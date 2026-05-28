-- F18 F1.4 — Shopee Campaign Center: tabela campaigns + view + seed.
--
-- READ-ONLY na Sprint 1 (UI mostra ROI + status; sem CRUD). Sprint 2
-- adiciona endpoints write quando Shopee Open Platform aprovar — aí o
-- service vai dispatchar pra /api/v2/voucher|discount|ads.
--
-- ⚠️ Sem BEGIN/COMMIT — RPC _admin_exec_sql rejeita transaction commands.

-- ── 1. Tabela campaigns ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopee.campaigns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  shop_id           bigint NOT NULL,

  kind              text NOT NULL
                    CHECK (kind IN ('voucher', 'flash_sale', 'ads')),
  status            text NOT NULL DEFAULT 'planned'
                    CHECK (status IN ('planned', 'active', 'paused', 'ended', 'cancelled')),

  title             text NOT NULL,
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,

  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz,                  -- null = evergreen (ads boost contínuo)

  -- Métricas agregadas (atualizadas por sync — F0.7 propaga)
  revenue_cents     bigint NOT NULL DEFAULT 0,
  cost_cents        bigint NOT NULL DEFAULT 0,
  orders            integer NOT NULL DEFAULT 0,
  views             integer,                      -- só ads
  clicks            integer,                      -- só ads

  -- Margin gate (F1.6 plugará no motor de margem)
  margin_warning    text,                          -- texto humano se margem pós-comissão < threshold
  margin_evaluated_at timestamptz,

  -- IDs externos (Shopee)
  external_id       text,                          -- voucher_id / discount_id / campaign_id
  raw               jsonb,                         -- snapshot último get da API

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT campaigns_window_valid
    CHECK (ends_at IS NULL OR ends_at >= starts_at),
  CONSTRAINT campaigns_revenue_nonneg CHECK (revenue_cents >= 0),
  CONSTRAINT campaigns_cost_nonneg    CHECK (cost_cents    >= 0),
  CONSTRAINT campaigns_orders_nonneg  CHECK (orders        >= 0)
);

COMMENT ON TABLE shopee.campaigns IS
  'F18 F1.4 — Campanhas Shopee (voucher/flash_sale/ads). Métricas agregadas no DB; ROI computed pelo service.';

CREATE INDEX IF NOT EXISTS idx_campaigns_org_status_starts
  ON shopee.campaigns (organization_id, status, starts_at DESC);

CREATE INDEX IF NOT EXISTS idx_campaigns_org_kind_status
  ON shopee.campaigns (organization_id, kind, status);

CREATE INDEX IF NOT EXISTS idx_campaigns_shop
  ON shopee.campaigns (shop_id, starts_at DESC);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION shopee.tg_campaigns_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_campaigns_touch ON shopee.campaigns;
CREATE TRIGGER trg_campaigns_touch
  BEFORE UPDATE ON shopee.campaigns
  FOR EACH ROW EXECUTE FUNCTION shopee.tg_campaigns_touch();

-- ── 2. View v_campaigns_with_shop ───────────────────────────────────
-- Inclui shop_name via JOIN + status_priority pra sort (ativas primeiro).
CREATE OR REPLACE VIEW shopee.v_campaigns_with_shop AS
SELECT
  c.id,
  c.organization_id,
  c.shop_id,
  c.kind,
  c.status,
  c.title,
  c.config,
  c.starts_at,
  c.ends_at,
  c.revenue_cents,
  c.cost_cents,
  c.orders,
  c.views,
  c.clicks,
  c.margin_warning,
  c.created_at,
  c.updated_at,
  conn.nickname AS shop_name,
  CASE c.status
    WHEN 'active'    THEN 1
    WHEN 'paused'    THEN 2
    WHEN 'planned'   THEN 3
    WHEN 'ended'     THEN 4
    WHEN 'cancelled' THEN 5
    ELSE 99
  END AS status_priority
FROM shopee.campaigns c
LEFT JOIN public.marketplace_connections conn
  ON conn.organization_id = c.organization_id
  AND conn.platform = 'shopee'
  AND conn.shop_id = c.shop_id
  AND conn.status = 'connected';

COMMENT ON VIEW shopee.v_campaigns_with_shop IS
  'F18 F1.4 — Campanhas com shop_name + status_priority pra sort.';

-- ── 3. RLS ──────────────────────────────────────────────────────────
ALTER TABLE shopee.campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members campaigns read" ON shopee.campaigns;
CREATE POLICY "org members campaigns read"
  ON shopee.campaigns FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  );

GRANT ALL    ON TABLE shopee.campaigns                TO service_role;
GRANT SELECT ON TABLE shopee.campaigns                TO authenticated;
GRANT SELECT ON shopee.v_campaigns_with_shop          TO authenticated, service_role;

-- ── 4. Seed demo (org Shopee Review Demo) ───────────────────────────
DO $$
DECLARE
  v_demo_org uuid;
BEGIN
  SELECT id INTO v_demo_org
  FROM public.organizations
  WHERE slug = 'shopee-review-demo';

  IF v_demo_org IS NULL THEN
    RAISE NOTICE 'org shopee-review-demo ausente — pulando seed campanhas';
    RETURN;
  END IF;

  -- Limpa seed antigo
  DELETE FROM shopee.campaigns
   WHERE organization_id = v_demo_org AND shop_id = 999990001;

  -- 1. VOUCHER ativo — codeless, 10% off, canal feed
  INSERT INTO shopee.campaigns (
    organization_id, shop_id, kind, status, title, config,
    starts_at, ends_at,
    revenue_cents, cost_cents, orders
  ) VALUES (
    v_demo_org, 999990001, 'voucher', 'active',
    'Voucher 10% — Iluminação Premium',
    jsonb_build_object(
      'kind', 'voucher',
      'voucher', jsonb_build_object(
        'code', NULL,
        'discount_type', 'percent',
        'discount_value', 0.10,
        'min_spend', 8990,
        'channel', 'feed',
        'usage_limit', 500
      )
    ),
    now() - interval '5 days', now() + interval '25 days',
    248700,   -- R$ 2.487
    24870,    -- R$ 248,70 (10% off em vendas)
    21
  );

  -- 2. FLASH SALE planejada — começa amanhã, 25% off em 3 SKUs
  INSERT INTO shopee.campaigns (
    organization_id, shop_id, kind, status, title, config,
    starts_at, ends_at,
    revenue_cents, cost_cents, orders,
    margin_warning
  ) VALUES (
    v_demo_org, 999990001, 'flash_sale', 'planned',
    'Flash Sale — 25% K9 Dourada',
    jsonb_build_object(
      'kind', 'flash_sale',
      'flash_sale', jsonb_build_object(
        'item_ids', jsonb_build_array(1001, 1002, 1003),
        'discount_type', 'percent',
        'discount_value', 0.25
      )
    ),
    date_trunc('day', now() + interval '1 day') + interval '20 hours',
    date_trunc('day', now() + interval '1 day') + interval '22 hours',
    0, 0, 0,
    'Margem pós-comissão estimada em 4.2% (limite recomendado ≥ 8%). Revisar custos antes de ativar.'
  );

  -- 3. ADS ativos — boost de produto Arandela K9
  INSERT INTO shopee.campaigns (
    organization_id, shop_id, kind, status, title, config,
    starts_at, ends_at,
    revenue_cents, cost_cents, orders, views, clicks
  ) VALUES (
    v_demo_org, 999990001, 'ads', 'active',
    'Shopee Ads — Boost K9 Dourada',
    jsonb_build_object(
      'kind', 'ads',
      'ads', jsonb_build_object(
        'ad_type', 'product',
        'budget_cents', 5000,
        'item_ids', jsonb_build_array(1001)
      )
    ),
    now() - interval '7 days', NULL,
    156300,   -- R$ 1.563 atribuído
    32450,    -- R$ 324,50 gasto em ads
    18,
    8400,
    412
  );
END $$;

-- ── 5. Roadmap → F1.4 wip (frontend vem em seguida nesta sprint) ────
DO $$
DECLARE
  vazzo_org  uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833';
  v_phase_id uuid;
BEGIN
  SELECT id INTO v_phase_id FROM public.roadmap_phases
   WHERE organization_id = vazzo_org AND num = 'F18';

  IF v_phase_id IS NOT NULL THEN
    UPDATE public.roadmap_items
       SET status = 'wip', updated_at = now()
     WHERE phase_id = v_phase_id
       AND label LIKE 'F1.4 —%';
  END IF;
END $$;
