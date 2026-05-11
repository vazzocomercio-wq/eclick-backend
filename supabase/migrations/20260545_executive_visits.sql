-- ============================================================
-- F11 ML Executive Dashboard IA — Camada E4 (Visitas + Conversão)
--
-- Sync diário de /users/{id}/items_visits/time_window pra cada
-- (org, seller). 1 row por dia. Cruzamento com orders local pra
-- conversion_rate_pct (sem call extra ML).
--
-- Decisões (vide reference_ml_api_shapes_f11):
--   • USA /time_window (date_from/date_to ISO retorna 400 BAD REQUEST).
--   • Shape: { total_visits, results: [{date, total, visits_detail[]}] }
--   • results[] vem fora de ordem cronológica — sortar antes de gravar.
--   • Último dia pode ser parcial (UI flagar incomplete).
--   • visits_detail[] permite breakdown por company (multimercados) —
--     preservar em JSONB pra futuro.
--   • GRANT explícito no fim (feedback_grant_admin_exec_sql)
--
-- Pendência adiada pra E4 fase 2: granularidade por item
-- (`/items/{id}/visits`) — necessário pra "top items muita visita,
-- pouca venda". Endpoint não validado no smoke.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ml_items_visits_daily (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  seller_id           BIGINT NOT NULL,

  date                DATE NOT NULL,

  -- Total do dia (soma de visits_detail[].quantity)
  total_visits        INTEGER NOT NULL DEFAULT 0,

  -- Breakdown por company (mercadolibre, etc) — preserva shape ML
  visits_detail       JSONB DEFAULT '[]'::jsonb,

  -- Flag: último dia da janela é parcial (hora 12 ≠ dia completo)
  is_partial          BOOLEAN DEFAULT false,

  -- Cruzamento com orders (sem call extra ML)
  total_orders        INTEGER DEFAULT 0,
  total_units_sold    INTEGER DEFAULT 0,
  conversion_rate_pct NUMERIC,           -- (orders / visits) × 100

  -- Comparação contextual
  visits_change_pct_vs_prev_day        NUMERIC,
  visits_change_pct_vs_same_day_lw     NUMERIC,  -- vs mesmo dia semana passada

  computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, seller_id, date)
);

CREATE INDEX IF NOT EXISTS idx_visits_daily_org_seller_date
  ON public.ml_items_visits_daily(organization_id, seller_id, date DESC);

-- GRANTs explícitos
GRANT ALL                              ON public.ml_items_visits_daily TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.ml_items_visits_daily TO authenticated;
