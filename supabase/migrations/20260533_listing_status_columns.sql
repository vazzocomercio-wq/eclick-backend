-- Re-aplica colunas listing_status (revertidas em 9801924 junto com regex bug).
-- IF NOT EXISTS = idempotente. Provavelmente as colunas já existem no DB de
-- antes do revert, este migration só garante o estado consistente.

-- ─── ml_campaign_items ────────────────────────────────────────
ALTER TABLE ml_campaign_items
  ADD COLUMN IF NOT EXISTS listing_status   text,    -- 'active' | 'paused' | 'closed' | 'under_review'
  ADD COLUMN IF NOT EXISTS catalog_listing  boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_camp_items_listing_status
  ON ml_campaign_items(organization_id, seller_id, listing_status);
CREATE INDEX IF NOT EXISTS idx_camp_items_catalog
  ON ml_campaign_items(organization_id, seller_id)
  WHERE catalog_listing = true;

-- ─── ml_quality_snapshots ─────────────────────────────────────
ALTER TABLE ml_quality_snapshots
  ADD COLUMN IF NOT EXISTS listing_status   text,
  ADD COLUMN IF NOT EXISTS catalog_listing  boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_quality_listing_status
  ON ml_quality_snapshots(organization_id, seller_id, listing_status);
CREATE INDEX IF NOT EXISTS idx_quality_catalog
  ON ml_quality_snapshots(organization_id, seller_id)
  WHERE catalog_listing = true;
