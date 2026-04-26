-- ML Ads campaigns carry an array of items (MLB ids) — store as JSONB so
-- we can show which listings each campaign promotes without an extra table.

ALTER TABLE ml_ads_campaigns
  ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]';
