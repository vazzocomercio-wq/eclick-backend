-- Generaliza ml_connections pra qualquer marketplace. Compat: ml_connections
-- continua existindo como tabela primária pra ML; marketplace_connections é
-- pros novos (Shopee/Magalu/Amazon) + recebe migração eager dos ML rows
-- pra leituras futuras. ml_connections fica intacta nesta sprint.

CREATE TABLE IF NOT EXISTS marketplace_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  platform        TEXT NOT NULL CHECK (platform IN ('mercadolivre','shopee','amazon','magalu')),

  -- Identificadores externos por plataforma (subset; outros nullable)
  seller_id       BIGINT,
  shop_id         BIGINT,
  partner_id      BIGINT,
  marketplace_id  TEXT,
  advertiser_id   BIGINT,
  external_id     TEXT,

  access_token    TEXT,
  refresh_token   TEXT,
  expires_at      TIMESTAMPTZ,

  -- aes-256-gcm app-side com MARKETPLACE_CONFIG_KEY.
  config_encrypted TEXT,

  status          TEXT DEFAULT 'connected' CHECK (status IN ('connected','expired','disconnected')),
  nickname        TEXT,
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),

  UNIQUE (organization_id, platform, COALESCE(shop_id::text, external_id, seller_id::text))
);

CREATE INDEX IF NOT EXISTS idx_mp_connections_org_platform
  ON marketplace_connections(organization_id, platform);
CREATE INDEX IF NOT EXISTS idx_mp_connections_status
  ON marketplace_connections(status) WHERE status = 'connected';

ALTER TABLE marketplace_connections ENABLE ROW LEVEL SECURITY;
GRANT ALL ON marketplace_connections TO service_role;
DROP POLICY IF EXISTS srv_mp_connections ON marketplace_connections;
CREATE POLICY srv_mp_connections ON marketplace_connections
  FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO marketplace_connections (
  organization_id, platform, seller_id, access_token, refresh_token,
  expires_at, nickname, created_at, updated_at
)
SELECT
  organization_id, 'mercadolivre', seller_id, access_token, refresh_token,
  expires_at, nickname, created_at, COALESCE(updated_at, created_at)
FROM ml_connections
ON CONFLICT DO NOTHING;
