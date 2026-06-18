-- Radar Shopee — config de auto-ingestão diária por org.
ALTER TABLE shopee.affiliate_connections
  ADD COLUMN IF NOT EXISTS radar_keywords text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS radar_auto boolean NOT NULL DEFAULT false;
-- expõe as colunas novas pro cliente (secret continua fora)
GRANT SELECT (id, organization_id, affiliate_id, status, app_id, created_at, updated_at, radar_keywords, radar_auto)
  ON shopee.affiliate_connections TO authenticated;
