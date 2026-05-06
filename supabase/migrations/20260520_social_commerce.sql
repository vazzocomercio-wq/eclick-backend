-- ============================================================
-- Onda 3 / S2 — Social Commerce (Instagram/Facebook Shop)
-- Tabelas pra integração com Meta Commerce Catalog API.
-- TikTok Shop (S3) reusa essas tabelas — só muda o channel.
-- ============================================================

-- Conexão de canal (org-level, 1 por canal)
CREATE TABLE IF NOT EXISTS social_commerce_channels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  channel TEXT NOT NULL CHECK (channel IN (
    'instagram_shop','facebook_shop','tiktok_shop','google_shopping'
  )),

  -- OAuth tokens (em produção devem ser cifrados — TODO Sprint hardening)
  access_token       TEXT,
  refresh_token      TEXT,
  token_expires_at   TIMESTAMPTZ,

  -- IDs externos do canal
  external_account_id TEXT,   -- Page ID / Business Account ID
  external_catalog_id TEXT,   -- Catalog ID no Meta Commerce
  external_pixel_id   TEXT,   -- Pixel ID pra tracking de conversões

  -- Config livre (ver doc abaixo por canal)
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Instagram exemplo:
  -- { "page_id": "123", "instagram_account_id": "456",
  --   "catalog_id": "789", "currency": "BRL",
  --   "auto_sync": true, "sync_interval_minutes": 60,
  --   "sync_fields": ["title","price","stock","images"] }

  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN (
    'disconnected','connecting','connected','error','paused'
  )),
  last_sync_at      TIMESTAMPTZ,
  last_sync_status  TEXT,
  last_error        TEXT,

  -- Métricas
  products_synced   INTEGER NOT NULL DEFAULT 0,
  sync_errors       INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_social_channels_org_channel
  ON social_commerce_channels(organization_id, channel);

CREATE INDEX IF NOT EXISTS idx_social_channels_status
  ON social_commerce_channels(status);

-- Mapeamento produto ↔ canal social
CREATE TABLE IF NOT EXISTS social_commerce_products (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id       UUID NOT NULL REFERENCES social_commerce_channels(id) ON DELETE CASCADE,
  product_id       UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- IDs externos
  external_product_id  TEXT,
  external_product_url TEXT,

  -- Status do sync por produto
  sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN (
    'pending','syncing','synced','error','rejected','paused'
  )),
  last_synced_at    TIMESTAMPTZ,
  last_error        TEXT,
  rejection_reason  TEXT,

  -- Snapshot do que foi mandado pro canal (pra detectar diff)
  synced_data JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Métricas do canal pra esse produto
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Ex: { "views": 500, "clicks": 45, "saves": 12, "purchases": 3 }

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_social_products_channel_product
  ON social_commerce_products(channel_id, product_id);

CREATE INDEX IF NOT EXISTS idx_social_products_org
  ON social_commerce_products(organization_id);
CREATE INDEX IF NOT EXISTS idx_social_products_status
  ON social_commerce_products(sync_status);
CREATE INDEX IF NOT EXISTS idx_social_products_pending
  ON social_commerce_products(channel_id, sync_status)
  WHERE sync_status IN ('pending','error');

-- updated_at triggers
CREATE OR REPLACE FUNCTION public.set_social_commerce_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_social_channels_updated_at ON social_commerce_channels;
CREATE TRIGGER trg_social_channels_updated_at
  BEFORE UPDATE ON social_commerce_channels
  FOR EACH ROW EXECUTE FUNCTION public.set_social_commerce_updated_at();

DROP TRIGGER IF EXISTS trg_social_products_updated_at ON social_commerce_products;
CREATE TRIGGER trg_social_products_updated_at
  BEFORE UPDATE ON social_commerce_products
  FOR EACH ROW EXECUTE FUNCTION public.set_social_commerce_updated_at();

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE social_commerce_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_commerce_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS social_channels_select ON social_commerce_channels;
CREATE POLICY social_channels_select ON social_commerce_channels
  FOR SELECT TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS social_channels_modify ON social_commerce_channels;
CREATE POLICY social_channels_modify ON social_commerce_channels
  FOR ALL TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS social_products_select ON social_commerce_products;
CREATE POLICY social_products_select ON social_commerce_products
  FOR SELECT TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS social_products_modify ON social_commerce_products;
CREATE POLICY social_products_modify ON social_commerce_products
  FOR ALL TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid()
    )
  );
