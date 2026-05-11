-- ============================================================
-- F10 ML Listing Center IA — L3 Sprint 6: Classificação de pausados
-- Refina o status scanner (Sprint 2 entregou classificação genérica;
-- aqui categorizamos por motivo específico pra UI agrupar e priorizar).
-- Spec canônica: docs/ml-listing-center-spec.md
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ml_listing_pause_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  seller_id BIGINT NOT NULL,
  ml_item_id TEXT NOT NULL,

  -- Status raw do ML
  ml_status TEXT NOT NULL,                   -- 'paused' | 'closed'
  ml_sub_status TEXT[] DEFAULT '{}'::text[],
  ml_tags TEXT[] DEFAULT '{}'::text[],
  ml_warnings JSONB,

  -- Classificação interna específica
  pause_category TEXT CHECK (pause_category IN (
    'out_of_stock',
    'paused_by_seller',
    'moderation_pending',
    'policy_violation',
    'image_problem',
    'description_problem',
    'price_problem',
    'category_problem',
    'restricted_product',
    'incomplete_required_fields',
    'expired',
    'unknown'
  )),
  pause_severity TEXT CHECK (pause_severity IN ('critical', 'high', 'medium', 'low')),

  -- Pode ser corrigido sozinho?
  is_self_solvable BOOLEAN DEFAULT false,
  suggested_fix TEXT,

  -- Quanto tempo parado
  paused_since TIMESTAMPTZ,
  days_paused INTEGER,

  -- Item meta (cache pra UI sem precisar re-fetch)
  item_title TEXT,
  item_price NUMERIC,
  item_sold_quantity INTEGER,

  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pause_class_org_seller
  ON public.ml_listing_pause_classifications(organization_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_pause_class_category
  ON public.ml_listing_pause_classifications(pause_category);
CREATE INDEX IF NOT EXISTS idx_pause_class_severity
  ON public.ml_listing_pause_classifications(pause_severity);
CREATE INDEX IF NOT EXISTS idx_pause_class_critical
  ON public.ml_listing_pause_classifications(pause_category)
  WHERE pause_category IN ('policy_violation', 'restricted_product');
CREATE UNIQUE INDEX IF NOT EXISTS idx_pause_class_unique
  ON public.ml_listing_pause_classifications(organization_id, seller_id, ml_item_id);

GRANT ALL ON public.ml_listing_pause_classifications TO service_role;
GRANT SELECT ON public.ml_listing_pause_classifications TO authenticated;

NOTIFY pgrst, 'reload schema';
