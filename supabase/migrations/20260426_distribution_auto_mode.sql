-- ── ESTOQUE ONDA 2 — Distribuição automática multicanal ─────────────────────
-- Adds tables and seed data needed by the new auto-distribution feature in
-- StockService. Backend code references these and degrades gracefully if
-- they're missing (queries return empty), but the feature only works after
-- this migration is applied.

-- 1. Catalog of marketplaces the system can talk to
CREATE TABLE IF NOT EXISTS marketplace_channels (
  id                  TEXT PRIMARY KEY,           -- mercadolivre, shopee, amazon, magalu...
  name                TEXT NOT NULL,
  logo_url            TEXT,
  api_status          TEXT DEFAULT 'available',   -- available | coming_soon | deprecated
  is_integrated       BOOLEAN DEFAULT false,      -- true after OAuth connect
  integration_status  TEXT,                       -- connected | expired | error | never_connected
  last_token_check    TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- 2. Seed initial channels (idempotent)
INSERT INTO marketplace_channels (id, name, api_status, is_integrated, integration_status) VALUES
  ('mercadolivre', 'Mercado Livre',  'available',   true,  'connected'),
  ('shopee',       'Shopee',         'available',   false, 'never_connected'),
  ('amazon',       'Amazon',         'available',   false, 'never_connected'),
  ('magalu',       'Magazine Luiza', 'available',   false, 'never_connected'),
  ('americanas',   'Americanas',     'coming_soon', false, 'never_connected'),
  ('netshoes',     'Netshoes',       'coming_soon', false, 'never_connected')
ON CONFLICT (id) DO NOTHING;

-- 3. Sales snapshots already exist (product_sales_snapshots) — ensure account_id column
ALTER TABLE product_sales_snapshots
  ADD COLUMN IF NOT EXISTS account_id TEXT;

-- 4. Audit log for every auto-recalc (cron daily + manual trigger)
CREATE TABLE IF NOT EXISTS distribution_recalc_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id           UUID REFERENCES products(id) ON DELETE CASCADE,
  triggered_by         TEXT,           -- cron_daily | user_manual
  channels_considered  JSONB,          -- [{channel, percentage}]
  channels_skipped     JSONB,          -- [{channel, reason}]
  result               JSONB,          -- [{channel, old_pct, new_pct}]
  applied              BOOLEAN DEFAULT true,
  created_at           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recalc_product
  ON distribution_recalc_log(product_id, created_at DESC);

-- 5. RLS — service_role full, authenticated read-only
ALTER TABLE marketplace_channels      ENABLE ROW LEVEL SECURITY;
ALTER TABLE distribution_recalc_log   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "srv_channels"  ON marketplace_channels;
DROP POLICY IF EXISTS "auth_channels" ON marketplace_channels;
CREATE POLICY "srv_channels"  ON marketplace_channels FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY "auth_channels" ON marketplace_channels FOR SELECT TO authenticated USING (true);
GRANT ALL    ON marketplace_channels TO service_role;
GRANT SELECT ON marketplace_channels TO authenticated;

DROP POLICY IF EXISTS "srv_recalc"  ON distribution_recalc_log;
DROP POLICY IF EXISTS "auth_recalc" ON distribution_recalc_log;
CREATE POLICY "srv_recalc"  ON distribution_recalc_log FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY "auth_recalc" ON distribution_recalc_log FOR SELECT TO authenticated USING (true);
GRANT ALL    ON distribution_recalc_log TO service_role;
GRANT SELECT ON distribution_recalc_log TO authenticated;
