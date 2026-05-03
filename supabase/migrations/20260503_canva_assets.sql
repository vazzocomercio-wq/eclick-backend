-- Sprint F5-2 / Batch 2.1 — Canva assets table.
-- Vincula designs Canva exportados a campanhas/produtos da org.
--
-- canva_design_id é a referência canônica (id do Canva).
-- storage_url é o mirror estável no Supabase Storage (URLs Canva expiram ~24h).
-- edit_url permite o seller voltar pro editor Canva.

CREATE TABLE IF NOT EXISTS canva_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid,                              -- quem criou (auth.users — soft FK)

  canva_design_id text NOT NULL,             -- id do design no Canva
  canva_export_job_id text,                  -- job_id do export (rastreio/debug)

  name text NOT NULL,
  format text NOT NULL CHECK (format IN ('png', 'jpg', 'pdf')),
  width integer,
  height integer,
  marketplace text,                          -- 'ml_produto', 'shopee_produto', etc — opcional

  thumbnail_url text,                        -- thumbnail do Canva (TTL ~24h)
  storage_path text,                         -- path no bucket canva-exports
  storage_url text,                          -- URL pública estável (mirror)
  edit_url text,                             -- link pro editor Canva (não expira)

  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,

  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canva_assets_org           ON canva_assets(organization_id);
CREATE INDEX IF NOT EXISTS idx_canva_assets_org_product   ON canva_assets(organization_id, product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_canva_assets_org_campaign  ON canva_assets(organization_id, campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_canva_assets_org_created   ON canva_assets(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_canva_assets_design        ON canva_assets(canva_design_id);

-- Bucket público pra mirror dos exports.
INSERT INTO storage.buckets (id, name, public)
VALUES ('canva-exports', 'canva-exports', true)
ON CONFLICT (id) DO NOTHING;

-- Policy de leitura pública (igual aos buckets de campanha).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'canva-exports public read'
  ) THEN
    CREATE POLICY "canva-exports public read" ON storage.objects
      FOR SELECT USING (bucket_id = 'canva-exports');
  END IF;
END $$;
