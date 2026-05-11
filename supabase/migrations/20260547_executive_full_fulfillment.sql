-- ============================================
-- F11 Fase 2 — Migration 1/3
-- Full Fulfillment Inventory Snapshot
--
-- Cron 1x/dia (03:00 BRT) popula via:
--   /users/{seller_id}/items/search?logistic_type=fulfillment
--   /items/{id}                                  (status, sub_status, qty)
--   /users/{seller_id}/sales                     (last_sold_at)
--
-- 1 row por (org, item_id, variation_id, captured_date) — snapshot diário
-- pra detectar estoque parado (last_sold_at antigo + available_quantity > 0).
--
-- ATENÇÃO: seller_id está como TEXT conforme solicitado pelo user, MAS o
-- resto do F11 usa BIGINT (ml_connections, orders, ml_listing_tasks,
-- ml_quality_snapshots, ml_seller_reputation_*, ml_logistics_summary,
-- ml_dashboard_summary, ml_ads_summary etc.). JOIN com essas tabelas
-- exige CAST. Decisão pendente do user.
-- ============================================

CREATE TABLE IF NOT EXISTS public.ml_fulfillment_inventory (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  seller_id       text NOT NULL,
  item_id         text NOT NULL,                  -- MLB ID
  inventory_id    text,                           -- FULL inventory ID (null se sem FULL)
  variation_id    text,                           -- se houver variação
  status          text,                           -- active, paused, closed
  sub_status      text[],                         -- ex: out_of_stock
  available_quantity      integer NOT NULL DEFAULT 0,
  not_available_quantity  integer NOT NULL DEFAULT 0,
  total_quantity          integer GENERATED ALWAYS AS
                          (available_quantity + not_available_quantity) STORED,
  last_sold_at    timestamptz,                    -- pra detectar estoque parado
  raw_payload     jsonb,                          -- snapshot bruto pra debug
  captured_at     timestamptz NOT NULL DEFAULT now(),
  -- AT TIME ZONE 'UTC' garante imutabilidade da expressão (cast direto
  -- captured_at::date depende do timezone da sessão e dá 42P17).
  captured_date   date GENERATED ALWAYS AS ((captured_at AT TIME ZONE 'UTC')::date) STORED,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- INDEXES ───────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS ux_ml_full_inv_org_item_var_day
  ON public.ml_fulfillment_inventory (organization_id, item_id, COALESCE(variation_id,''), captured_date);

CREATE INDEX IF NOT EXISTS ix_ml_full_inv_org_captured
  ON public.ml_fulfillment_inventory (organization_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS ix_ml_full_inv_org_inventory
  ON public.ml_fulfillment_inventory (organization_id, inventory_id)
  WHERE inventory_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_ml_full_inv_org_seller
  ON public.ml_fulfillment_inventory (organization_id, seller_id, captured_at DESC);

-- Estoque parado (sem venda há 30+ dias) — filtra pra parciais
CREATE INDEX IF NOT EXISTS ix_ml_full_inv_stale
  ON public.ml_fulfillment_inventory (organization_id, last_sold_at)
  WHERE available_quantity > 0;

-- RLS ───────────────────────────────────────────────────────────────
ALTER TABLE public.ml_fulfillment_inventory ENABLE ROW LEVEL SECURITY;

CREATE POLICY ml_full_inv_org_select
  ON public.ml_fulfillment_inventory FOR SELECT
  USING (
    organization_id IN (
      SELECT om.organization_id
      FROM public.organization_members om
      WHERE om.user_id = auth.uid()
    )
  );

CREATE POLICY ml_full_inv_service_role_all
  ON public.ml_fulfillment_inventory FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ml_fulfillment_inventory IS
  'F11 Fase 2: snapshot diário de inventário FULL (Mercado Livre Fulfillment). Populado por cron 3h/dia via /users/{seller_id}/items/search?logistic_type=fulfillment + /items/{id} + /users/{seller_id}/sales (last_sold_at).';

-- GRANTs explícitos (feedback_grant_admin_exec_sql — RLS sem GRANT = permission denied)
GRANT ALL                              ON public.ml_fulfillment_inventory TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.ml_fulfillment_inventory TO authenticated;
