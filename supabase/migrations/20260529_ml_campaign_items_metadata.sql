-- Re-applies thumbnail/title/permalink metadata columns for ml_campaign_items.
-- Original migration (20260525) was deleted in revert 9801924. Columns may
-- already exist on Supabase; ALTER ... IF NOT EXISTS keeps this idempotent.
-- Enriquecido via /items?ids=X1,X2,...&attributes=id,thumbnail,title,permalink
-- (call em batch de 20).

ALTER TABLE ml_campaign_items
  ADD COLUMN IF NOT EXISTS thumbnail_url           text,
  ADD COLUMN IF NOT EXISTS title                   text,
  ADD COLUMN IF NOT EXISTS permalink               text,
  ADD COLUMN IF NOT EXISTS last_metadata_synced_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_camp_items_metadata_pending
  ON ml_campaign_items(organization_id, seller_id)
  WHERE thumbnail_url IS NULL;
