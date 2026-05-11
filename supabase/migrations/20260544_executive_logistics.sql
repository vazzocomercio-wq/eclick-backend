-- ============================================================
-- F11 ML Executive Dashboard IA — Camada E3 (Logística)
--
-- Foundation pra detecção de atrasos e Flex elegível.
-- FULL FULFILLMENT fica pra fase 2 (smoke não validou shape).
--
-- Tabelas:
--   1. ml_shipment_delays — atrasos detectados via /shipments/{id}/delays
--   2. ml_flex_status     — has_flex por item (/flex/sites/MLB/items/{id}/v2)
--   3. ml_logistics_summary — cache resumido (1 row por org+seller)
--
-- Decisões (vide reference_ml_api_shapes_f11):
--   • /shipments/{id}/delays retorna 404 quando SEM atraso (positivo);
--     scanner dedupa shipping_id antes de iterar (orders multi-item).
--   • /flex/.../v2 retorna SOMENTE {has_flex} — sem active/zones.
--     Schema simplificado pra refletir realidade.
--   • Fonte de shipment_id: orders.shipping_id (já populado).
--   • "Envios pra despachar hoje" = orders WHERE shipping_status='ready_to_ship'
--     (sem call extra ML — já temos esse dado local).
--   • GRANT explícito no fim (feedback_grant_admin_exec_sql)
-- ============================================================

-- 1. ml_shipment_delays — atrasos detectados ───────────────────────────
CREATE TABLE IF NOT EXISTS public.ml_shipment_delays (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  seller_id                   BIGINT NOT NULL,

  ml_shipment_id              TEXT NOT NULL,
  ml_order_id                 TEXT,

  -- Tipo de delay
  delay_type                  TEXT NOT NULL CHECK (delay_type IN (
    'handling_delayed',  -- atraso na separação/despacho do seller
    'sla_delayed',       -- atraso no SLA total
    'transit_delayed'    -- atraso em trânsito (transportadora)
  )),

  delay_days                  INTEGER,
  expected_date               DATE,
  actual_date                 DATE,

  status                      TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open',          -- atraso ainda ativo
    'resolved',      -- entrega ocorreu
    'auto_resolved'  -- ML marcou como resolvido (próxima sync = 404)
  )),

  affects_reputation          BOOLEAN DEFAULT true,
  affects_metrics_period      TEXT,

  raw_response                JSONB,
  detected_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at                 TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_shipment_delays_org_seller
  ON public.ml_shipment_delays(organization_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_shipment_delays_open
  ON public.ml_shipment_delays(organization_id, seller_id)
  WHERE status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipment_delays_unique
  ON public.ml_shipment_delays(ml_shipment_id, delay_type);

-- 2. ml_flex_status — has_flex por item ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ml_flex_status (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  seller_id                   BIGINT NOT NULL,

  ml_item_id                  TEXT NOT NULL,
  product_id                  UUID REFERENCES public.products(id) ON DELETE SET NULL,

  -- API ML /flex/sites/MLB/items/{id}/v2 retorna SOMENTE has_flex.
  -- Pra distinguir "Flex ativo entregando" vs "elegível inativo" precisaria
  -- de outro endpoint (não validado no smoke).
  has_flex                    BOOLEAN NOT NULL,

  raw_response                JSONB,
  fetched_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (organization_id, seller_id, ml_item_id)
);

CREATE INDEX IF NOT EXISTS idx_flex_status_org_seller
  ON public.ml_flex_status(organization_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_flex_status_eligible
  ON public.ml_flex_status(organization_id, seller_id)
  WHERE has_flex = true;

-- 3. ml_logistics_summary — cache resumido ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.ml_logistics_summary (
  id                                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                     UUID NOT NULL,
  seller_id                           BIGINT NOT NULL,

  -- Envios (hoje)
  shipments_to_dispatch_today         INTEGER DEFAULT 0,  -- orders.shipping_status='ready_to_ship'
  shipments_dispatched_today          INTEGER DEFAULT 0,  -- shipping_status='shipped' criado hoje
  shipments_delivered_today           INTEGER DEFAULT 0,

  -- Atrasos
  open_delays_count                   INTEGER DEFAULT 0,
  open_delays_handling                INTEGER DEFAULT 0,
  open_delays_sla                     INTEGER DEFAULT 0,
  open_delays_transit                 INTEGER DEFAULT 0,

  -- Flex (a partir do scan via /flex/.../v2)
  flex_eligible_count                 INTEGER DEFAULT 0,
  flex_scan_coverage_pct              NUMERIC,  -- % de items que tem entrada em ml_flex_status

  -- Janela coberta pelo scan
  last_delay_scan_at                  TIMESTAMPTZ,
  last_flex_scan_at                   TIMESTAMPTZ,
  last_synced_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_sync_at                        TIMESTAMPTZ,

  UNIQUE (organization_id, seller_id)
);

CREATE INDEX IF NOT EXISTS idx_logistics_summary_org_seller
  ON public.ml_logistics_summary(organization_id, seller_id);

-- 4. GRANTs explícitos ─────────────────────────────────────────────────
GRANT ALL                              ON public.ml_shipment_delays    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.ml_shipment_delays    TO authenticated;

GRANT ALL                              ON public.ml_flex_status        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.ml_flex_status        TO authenticated;

GRANT ALL                              ON public.ml_logistics_summary  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.ml_logistics_summary  TO authenticated;
