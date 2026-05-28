-- F18 F1.3 — Shopee Quality Center: tabela shop_metrics + view latest + seed.
--
-- Métricas de saúde POR LOJA (não por anúncio). 1 snapshot por dia
-- (UNIQUE org+shop+date). Histórico permite mini-gráficos de tendência.
--
-- ⚠️ Sem BEGIN/COMMIT — RPC _admin_exec_sql rejeita transaction commands.
--
-- Source 'extension' antecipa: chat_response_rate/prep_time_days/
-- penalty_points não são expostos pela Open Platform API → vão precisar
-- de F12 Chrome Extension scraping na Sprint 2. Por ora null OK.

-- ── 1. Tabela shop_metrics ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopee.shop_metrics (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  shop_id                 bigint NOT NULL,
  snapshot_date           date NOT NULL DEFAULT CURRENT_DATE,

  -- Chat
  chat_response_rate      numeric(4,3),               -- 0-1
  chat_response_time_min  numeric(8,2),               -- minutos

  -- Logística
  prep_time_days          numeric(4,2),
  late_ship_rate          numeric(4,3),               -- 0-1

  -- Pós-venda
  return_refund_rate      numeric(4,3),               -- 0-1
  rating                  numeric(3,2),               -- 0-5

  -- Compliance
  penalty_points          smallint,

  -- Raw + meta
  raw                     jsonb,
  source                  text NOT NULL DEFAULT 'api'
                          CHECK (source IN ('api','extension','manual')),

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT shop_metrics_rate_range
    CHECK (chat_response_rate IS NULL OR chat_response_rate BETWEEN 0 AND 1),
  CONSTRAINT shop_metrics_late_range
    CHECK (late_ship_rate IS NULL OR late_ship_rate BETWEEN 0 AND 1),
  CONSTRAINT shop_metrics_returns_range
    CHECK (return_refund_rate IS NULL OR return_refund_rate BETWEEN 0 AND 1),
  CONSTRAINT shop_metrics_rating_range
    CHECK (rating IS NULL OR rating BETWEEN 0 AND 5),
  CONSTRAINT shop_metrics_penalty_nonneg
    CHECK (penalty_points IS NULL OR penalty_points >= 0)
);

COMMENT ON TABLE shopee.shop_metrics IS
  'F18 F1.3 — Snapshot diário de saúde da loja Shopee. UNIQUE (org, shop, date) força 1 row/dia. UI Quality Center lê via v_latest_shop_metrics.';

-- 1 snapshot por dia por loja
CREATE UNIQUE INDEX IF NOT EXISTS uniq_shop_metrics_org_shop_date
  ON shopee.shop_metrics (organization_id, shop_id, snapshot_date);

-- History queries (ORDER BY snapshot_date ASC limit por N dias)
CREATE INDEX IF NOT EXISTS idx_shop_metrics_org_shop_date_desc
  ON shopee.shop_metrics (organization_id, shop_id, snapshot_date DESC);

-- Alertas: caçar lojas em penalty alto rapidamente
CREATE INDEX IF NOT EXISTS idx_shop_metrics_high_penalty
  ON shopee.shop_metrics (organization_id, penalty_points DESC, snapshot_date DESC)
  WHERE penalty_points >= 3;

-- Trigger updated_at
CREATE OR REPLACE FUNCTION shopee.tg_shop_metrics_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shop_metrics_touch ON shopee.shop_metrics;
CREATE TRIGGER trg_shop_metrics_touch
  BEFORE UPDATE ON shopee.shop_metrics
  FOR EACH ROW EXECUTE FUNCTION shopee.tg_shop_metrics_touch();

-- ── 2. View latest_shop_metrics ─────────────────────────────────────
-- DISTINCT ON (org, shop) ORDER BY snapshot_date DESC. Inclui shop_name
-- via LEFT JOIN com marketplace_connections (best-effort; null se não
-- conectada). Front consome isso direto.
CREATE OR REPLACE VIEW shopee.v_latest_shop_metrics AS
SELECT DISTINCT ON (m.organization_id, m.shop_id)
  m.id,
  m.organization_id,
  m.shop_id,
  m.snapshot_date,
  m.chat_response_rate,
  m.chat_response_time_min,
  m.prep_time_days,
  m.late_ship_rate,
  m.return_refund_rate,
  m.rating,
  m.penalty_points,
  m.raw,
  m.source,
  m.created_at,
  m.updated_at,
  c.nickname AS shop_name
FROM shopee.shop_metrics m
LEFT JOIN public.marketplace_connections c
  ON c.organization_id = m.organization_id
  AND c.platform = 'shopee'
  AND c.shop_id = m.shop_id
  AND c.status = 'connected'
ORDER BY m.organization_id, m.shop_id, m.snapshot_date DESC;

COMMENT ON VIEW shopee.v_latest_shop_metrics IS
  'F18 F1.3 — Snapshot mais recente por (org, shop) + shop_name via JOIN com marketplace_connections.';

-- ── 3. RLS ──────────────────────────────────────────────────────────
ALTER TABLE shopee.shop_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members shop_metrics read" ON shopee.shop_metrics;
CREATE POLICY "org members shop_metrics read"
  ON shopee.shop_metrics FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  );

GRANT ALL    ON TABLE shopee.shop_metrics             TO service_role;
GRANT SELECT ON TABLE shopee.shop_metrics             TO authenticated;
GRANT SELECT ON shopee.v_latest_shop_metrics          TO authenticated, service_role;

-- ── 4. Seed demo na org Shopee Review Demo ──────────────────────────
-- 2 lojas: 999990001 (saudável) + 999990002 (em punição).
-- 7 dias de history pra cada — UI faz mini-gráfico de tendência.
DO $$
DECLARE
  v_demo_org uuid;
  v_day      int;
  v_date     date;
BEGIN
  SELECT id INTO v_demo_org
  FROM public.organizations
  WHERE slug = 'shopee-review-demo';

  IF v_demo_org IS NULL THEN
    RAISE NOTICE 'org shopee-review-demo ausente — pulando seed';
    RETURN;
  END IF;

  -- Limpa seed antigo
  DELETE FROM shopee.shop_metrics
   WHERE organization_id = v_demo_org
     AND shop_id IN (999990001, 999990002);

  -- LOJA SAUDÁVEL (999990001) — 7 dias estáveis, tudo verde
  FOR v_day IN 0..6 LOOP
    v_date := CURRENT_DATE - v_day;
    INSERT INTO shopee.shop_metrics (
      organization_id, shop_id, snapshot_date,
      chat_response_rate, chat_response_time_min,
      prep_time_days, late_ship_rate,
      return_refund_rate, rating, penalty_points,
      source
    ) VALUES (
      v_demo_org, 999990001, v_date,
      0.96 - (v_day * 0.001),         -- 96-95.4%
      4 + (v_day * 0.3),               -- 4-6min
      0.8 + (v_day * 0.05),            -- 0.8-1.1d
      0.005 + (v_day * 0.0005),        -- 0.5-0.8%
      0.015 + (v_day * 0.001),         -- 1.5-2.1%
      4.9 - (v_day * 0.01),            -- 4.84-4.9
      0,
      'manual'
    );
  END LOOP;

  -- LOJA EM PUNIÇÃO (999990002) — tendência piorando ao longo da semana
  FOR v_day IN 0..6 LOOP
    v_date := CURRENT_DATE - v_day;
    INSERT INTO shopee.shop_metrics (
      organization_id, shop_id, snapshot_date,
      chat_response_rate, chat_response_time_min,
      prep_time_days, late_ship_rate,
      return_refund_rate, rating, penalty_points,
      source
    ) VALUES (
      v_demo_org, 999990002, v_date,
      0.55 + (v_day * 0.02),           -- piora pro hoje
      500 - (v_day * 50),               -- pior hoje
      4.5 - (v_day * 0.1),             -- pior hoje
      0.18 - (v_day * 0.01),
      0.14 - (v_day * 0.005),
      3.6 + (v_day * 0.05),
      7 - (v_day),                      -- escalando até 7 hoje
      'manual'
    );
  END LOOP;
END $$;

-- ── 5. Roadmap F1.3 → wip (frontend pendente) ───────────────────────
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
       AND label LIKE 'F1.3 —%';
  END IF;
END $$;
