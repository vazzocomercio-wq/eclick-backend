-- Radar Shopee — "Observar" produto: marca pra monitoramento diário garantido.
ALTER TABLE shopee.affiliate_offers ADD COLUMN IF NOT EXISTS watched boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_aff_offers_watched
  ON shopee.affiliate_offers (organization_id, watched) WHERE watched = true;
