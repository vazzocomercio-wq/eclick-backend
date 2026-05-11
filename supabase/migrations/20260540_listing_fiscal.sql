-- ============================================================
-- F10 ML Listing Center IA — L3 Sprint 5: Snapshot fiscal por item
-- Detecta NCM/GTIN/origem/CEST/brand/model ausentes. Bloqueia
-- emissão de NF-e quando NCM, GTIN ou ORIGIN faltam.
-- Spec canônica: docs/ml-listing-center-spec.md
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ml_listing_fiscal_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  seller_id BIGINT NOT NULL,
  ml_item_id TEXT NOT NULL,
  product_id UUID REFERENCES public.products(id),

  -- Atributos fiscais checados
  has_ncm BOOLEAN DEFAULT false,
  ncm_value TEXT,
  has_gtin BOOLEAN DEFAULT false,
  gtin_value TEXT,
  has_origin BOOLEAN DEFAULT false,
  origin_value TEXT,
  has_cest BOOLEAN DEFAULT false,
  cest_value TEXT,
  has_brand BOOLEAN DEFAULT false,
  brand_value TEXT,
  has_model BOOLEAN DEFAULT false,
  model_value TEXT,

  -- Score fiscal (0-100): % dos 6 checks que passam
  fiscal_completeness_score INTEGER,

  -- Bloqueia NF-e? True se faltar NCM, GTIN OU ORIGIN
  blocks_nfe BOOLEAN DEFAULT false,
  missing_fields TEXT[] DEFAULT '{}'::text[],

  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fiscal_snap_org_seller
  ON public.ml_listing_fiscal_snapshots(organization_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_snap_item
  ON public.ml_listing_fiscal_snapshots(ml_item_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_snap_blocks
  ON public.ml_listing_fiscal_snapshots(blocks_nfe)
  WHERE blocks_nfe = true;
CREATE INDEX IF NOT EXISTS idx_fiscal_snap_score
  ON public.ml_listing_fiscal_snapshots(fiscal_completeness_score);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fiscal_snap_unique
  ON public.ml_listing_fiscal_snapshots(organization_id, seller_id, ml_item_id);

GRANT ALL ON public.ml_listing_fiscal_snapshots TO service_role;
GRANT SELECT ON public.ml_listing_fiscal_snapshots TO authenticated;

NOTIFY pgrst, 'reload schema';
