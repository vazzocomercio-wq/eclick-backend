-- Sprint F5-2 — assets gerados (imagens de capa) por campanhas, com TTL
-- de 30 dias quando não aprovadas. Provider pode ser openai (gpt-image-1),
-- flux (Black Forest Labs — TODO sprint futura), ou canva_upload (asset
-- enviado pra editor Canva via OAuth pessoal).
--
-- ⚠️ ANTES DE TESTAR: criar bucket "campaign-assets" no Supabase Dashboard
-- (Storage → New bucket → public). Ou via API: POST /storage/v1/bucket.
--
-- Rollback:
--   DROP TABLE IF EXISTS campaign_assets;

BEGIN;

CREATE TABLE IF NOT EXISTS campaign_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id     uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  type            text NOT NULL CHECK (type IN ('image','video')),
  format          text NOT NULL,  -- 'square_1080','story_1080x1920','feed_1080x1350','custom'
  width           integer NOT NULL,
  height          integer NOT NULL,
  storage_path    text NOT NULL,  -- bucket/path
  storage_url     text,           -- assinada (30d) ou pública
  provider        text NOT NULL,  -- 'openai','flux','canva_upload'
  model           text,           -- 'gpt-image-1','flux-pro' etc
  prompt          text,
  source_image_url text,          -- imagem que serviu de base (anúncio/produto)
  cost_usd        numeric DEFAULT 0,
  approved        boolean NOT NULL DEFAULT false,
  approved_at     timestamptz,
  metadata        jsonb,          -- extras (canva_design_id, etc)
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz     -- NULL = nunca expira (aprovada vinculada a campanha)
);

CREATE INDEX IF NOT EXISTS campaign_assets_org_created_idx
  ON campaign_assets (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS campaign_assets_expires_idx
  ON campaign_assets (expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS campaign_assets_campaign_idx
  ON campaign_assets (campaign_id, approved) WHERE campaign_id IS NOT NULL;

ALTER TABLE campaign_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members campaign_assets" ON campaign_assets;
CREATE POLICY "org members campaign_assets" ON campaign_assets FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

GRANT ALL ON campaign_assets TO service_role;

COMMIT;
