-- ============================================
-- F11 Fase 2 — Bloco 1.1 — Fix seller_id TEXT → BIGINT
--
-- Padronização com resto do F11 (ml_connections, orders, ml_listing_tasks,
-- ml_seller_reputation_*, ml_quality_snapshots, ml_logistics_summary,
-- ml_flex_status, ml_items_visits_daily, ml_shipment_delays, ml_dashboard_summary).
-- Tabela vazia (0 rows) — cast custo zero.
-- ============================================

ALTER TABLE public.ml_fulfillment_inventory
  ALTER COLUMN seller_id TYPE BIGINT USING seller_id::BIGINT;
