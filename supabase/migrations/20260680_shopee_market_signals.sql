-- F18 F1.5 — Radar Shopee: tabela market_signals + view latest + seed demo.
--
-- 3 tipos de sinal:
--   • trending        — produto/categoria em alta (metric_value = score 0-100)
--   • price_benchmark — preço médio do líder (metric_value = cents do líder)
--   • fbs_adoption    — % vendedores com Frete Grátis Shopee (0-1)
--
-- Granularidade dual: por categoria SEMPRE + por item_id opcional (drill
-- down). Upsert diário por (org, type, category, item) — captured_at vira
-- a "data" de discriminação.
--
-- Cross-link com Active radar: bridge view `active.v_saas_shopee_signals`
-- entra cross-repo no eclick-active depois (mesmo pattern de
-- v_saas_tiktok_products já existente).

-- ── 1. Tabela ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopee.market_signals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  signal_type     text NOT NULL
                  CHECK (signal_type IN ('trending', 'price_benchmark', 'fbs_adoption')),
  category_id     bigint NOT NULL,
  category_name   text,
  item_id         bigint,                       -- opcional (price_benchmark de SKU específico)

  metric_value    numeric NOT NULL,             -- shape depende do tipo
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,

  captured_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT market_signals_metric_nonneg CHECK (metric_value >= 0),
  CONSTRAINT market_signals_pct_range
    CHECK (signal_type <> 'fbs_adoption' OR metric_value <= 1.0)
);

COMMENT ON TABLE shopee.market_signals IS
  'F18 F1.5 — Sinais de mercado coletados do Radar Shopee. Histórico por (org, type, category, item_id). View v_latest devolve mais recente.';

-- 1 sinal por (org, type, cat, item, captured_at) — histórico via captured_at distintas
CREATE INDEX IF NOT EXISTS idx_market_signals_org_type_cat
  ON shopee.market_signals (organization_id, signal_type, category_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_signals_org_item
  ON shopee.market_signals (organization_id, item_id, captured_at DESC)
  WHERE item_id IS NOT NULL;

-- ── 2. View latest ──────────────────────────────────────────────────
-- DISTINCT ON pega mais recente por (org, type, category, item_id).
-- COALESCE(item_id, 0) pra agrupar nulos juntos.
CREATE OR REPLACE VIEW shopee.v_latest_market_signals AS
SELECT DISTINCT ON (organization_id, signal_type, category_id, COALESCE(item_id, 0))
  id,
  organization_id,
  signal_type,
  category_id,
  category_name,
  item_id,
  metric_value,
  payload,
  captured_at,
  created_at
FROM shopee.market_signals
ORDER BY organization_id, signal_type, category_id, COALESCE(item_id, 0), captured_at DESC;

COMMENT ON VIEW shopee.v_latest_market_signals IS
  'F18 F1.5 — Sinal mais recente por (org, type, category, item). Listing Center cruza com price_benchmark pra badge "preço X% acima do líder".';

-- ── 3. RLS + grants ─────────────────────────────────────────────────
ALTER TABLE shopee.market_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members market_signals read" ON shopee.market_signals;
CREATE POLICY "org members market_signals read"
  ON shopee.market_signals FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  );

GRANT ALL    ON TABLE shopee.market_signals          TO service_role;
GRANT SELECT ON TABLE shopee.market_signals          TO authenticated;
GRANT SELECT ON shopee.v_latest_market_signals       TO authenticated, service_role;

-- ── 4. Seed demo (org Shopee Review Demo) ───────────────────────────
-- Categoria Iluminação (Shopee category_id fake 100401 = Casa & Decoração
-- > Iluminação > Arandelas). Reviewers verão Radar com dados realistas.
DO $$
DECLARE
  v_demo_org uuid;
BEGIN
  SELECT id INTO v_demo_org
  FROM public.organizations
  WHERE slug = 'shopee-review-demo';

  IF v_demo_org IS NULL THEN
    RAISE NOTICE 'org shopee-review-demo ausente — pulando seed Radar';
    RETURN;
  END IF;

  DELETE FROM shopee.market_signals
   WHERE organization_id = v_demo_org;

  -- TRENDING — 3 categorias em alta
  INSERT INTO shopee.market_signals
    (organization_id, signal_type, category_id, category_name, metric_value, payload)
  VALUES
    (v_demo_org, 'trending', 100401, 'Arandelas', 87,
      jsonb_build_object(
        'summary', 'Arandelas em alta: +34% busca nos últimos 7 dias',
        'trend',   'up',
        'delta',   0.34,
        'top', jsonb_build_array(
          jsonb_build_object('item_id', 1001, 'title', 'Arandela LED Cristal K9 Dourada', 'estimated_sales_7d', 142),
          jsonb_build_object('item_id', 1002, 'title', 'Arandela LED Dourada Quadrada',   'estimated_sales_7d', 98),
          jsonb_build_object('item_id', 1003, 'title', 'Arandela Industrial Preta',       'estimated_sales_7d', 67)
        )
      )
    ),
    (v_demo_org, 'trending', 100402, 'Lustres', 72,
      jsonb_build_object(
        'summary', 'Lustres pendente — alta sazonal Dia das Mães',
        'trend',   'up',
        'delta',   0.18,
        'top', jsonb_build_array(
          jsonb_build_object('title', 'Lustre Pendente Globo Vidro', 'estimated_sales_7d', 56)
        )
      )
    ),
    (v_demo_org, 'trending', 100403, 'Spots de Embutir', 45,
      jsonb_build_object(
        'summary', 'Spots — busca caindo 8% (sazonal)',
        'trend',   'down',
        'delta',   -0.08
      )
    );

  -- PRICE_BENCHMARK — preço médio líder por categoria
  INSERT INTO shopee.market_signals
    (organization_id, signal_type, category_id, category_name, metric_value, payload)
  VALUES
    (v_demo_org, 'price_benchmark', 100401, 'Arandelas', 9990,
      jsonb_build_object(
        'summary', 'Preço médio líder: R$ 99,90 (4.9★, com FBS)',
        'leader', jsonb_build_object(
          'shop_id',     999990003,
          'title',       'Arandela LED Cristal Premium Dourada',
          'price_cents', 9990,
          'rating',      4.9,
          'is_fbs',      true
        )
      )
    ),
    (v_demo_org, 'price_benchmark', 100402, 'Lustres', 18790,
      jsonb_build_object(
        'summary', 'Preço médio líder: R$ 187,90 (4.8★, sem FBS)',
        'leader', jsonb_build_object(
          'title',       'Lustre Pendente Vidro Soprado',
          'price_cents', 18790,
          'rating',      4.8,
          'is_fbs',      false
        )
      )
    );

  -- FBS_ADOPTION — % vendedores com FBS na categoria
  INSERT INTO shopee.market_signals
    (organization_id, signal_type, category_id, category_name, metric_value, payload)
  VALUES
    (v_demo_org, 'fbs_adoption', 100401, 'Arandelas', 0.62,
      jsonb_build_object(
        'summary', '62% dos vendedores top 50 já usam FBS',
        'fbs',     jsonb_build_object('count', 31, 'total', 50)
      )
    ),
    (v_demo_org, 'fbs_adoption', 100402, 'Lustres', 0.38,
      jsonb_build_object(
        'summary', '38% dos vendedores top 50 usam FBS — mercado ainda fragmentado',
        'fbs',     jsonb_build_object('count', 19, 'total', 50)
      )
    ),
    (v_demo_org, 'fbs_adoption', 100403, 'Spots de Embutir', 0.74,
      jsonb_build_object(
        'summary', '74% adoção FBS — competir sem FBS é caro',
        'fbs',     jsonb_build_object('count', 37, 'total', 50)
      )
    );
END $$;

-- ── 5. Roadmap → F1.5 done ──────────────────────────────────────────
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
       AND label LIKE 'F1.5 —%';
  END IF;
END $$;
