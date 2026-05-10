-- ============================================================
-- F10 ML Listing Center IA — L2 Pricing Intelligence
-- Cache de sugestões de preço via /items/{id}/price_to_win.
-- (Spec atualizada pós-smoke-test: /suggestions/items/{id} NÃO existe;
-- price_to_win retorna shape muito mais rico — buy_box_status,
-- visit_share, competitors_sharing, catalog_product_id, winner, boosts.)
-- Spec canônica: docs/ml-listing-center-spec.md
-- ============================================================

-- 1. ml_listing_pricing_suggestions ──────────────────────────
CREATE TABLE IF NOT EXISTS public.ml_listing_pricing_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  seller_id BIGINT NOT NULL,
  ml_item_id TEXT NOT NULL,
  product_id UUID REFERENCES public.products(id),

  -- Preço atual vs sugerido (price_to_win)
  current_price NUMERIC NOT NULL,
  suggested_price NUMERIC NOT NULL,
  price_difference_brl NUMERIC GENERATED ALWAYS AS (current_price - suggested_price) STORED,
  price_difference_pct NUMERIC GENERATED ALWAYS AS (
    CASE WHEN current_price > 0 THEN ((current_price - suggested_price) / current_price) * 100 ELSE 0 END
  ) STORED,

  -- Status competitivo (do price_to_win)
  buy_box_status TEXT CHECK (buy_box_status IN ('winning', 'losing', 'sharing_first_place')),
  visit_share TEXT CHECK (visit_share IN ('maximum', 'medium', 'low')),
  competitors_sharing INTEGER DEFAULT 0,
  consistent BOOLEAN DEFAULT true,
  reason TEXT[] DEFAULT '{}',

  -- Catálogo / vencedor atual
  catalog_product_id TEXT,
  winner_item_id TEXT,
  winner_price NUMERIC,

  -- Boosts ativos (Full, frete grátis, cross-docking, etc.)
  boosts JSONB DEFAULT '{}'::jsonb,

  -- Validações internas (com nosso custo)
  internal_margin_at_suggested_pct NUMERIC,
  is_below_min_margin BOOLEAN DEFAULT false,
  is_below_cost BOOLEAN DEFAULT false,

  -- Raw response para debug / auditoria
  raw_response JSONB,

  -- Cache control
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pricing_sugg_org_seller
  ON public.ml_listing_pricing_suggestions(organization_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_pricing_sugg_item
  ON public.ml_listing_pricing_suggestions(ml_item_id);
CREATE INDEX IF NOT EXISTS idx_pricing_sugg_diff
  ON public.ml_listing_pricing_suggestions(price_difference_pct DESC);
CREATE INDEX IF NOT EXISTS idx_pricing_sugg_expires
  ON public.ml_listing_pricing_suggestions(expires_at);
CREATE INDEX IF NOT EXISTS idx_pricing_sugg_buybox
  ON public.ml_listing_pricing_suggestions(buy_box_status)
  WHERE buy_box_status IN ('losing', 'sharing_first_place');
CREATE INDEX IF NOT EXISTS idx_pricing_sugg_catalog
  ON public.ml_listing_pricing_suggestions(catalog_product_id)
  WHERE catalog_product_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_sugg_unique
  ON public.ml_listing_pricing_suggestions(organization_id, seller_id, ml_item_id);

-- 2. GRANTs explícitos ────────────────────────────────────────
GRANT ALL ON public.ml_listing_pricing_suggestions TO service_role;
GRANT SELECT ON public.ml_listing_pricing_suggestions TO authenticated;

NOTIFY pgrst, 'reload schema';
