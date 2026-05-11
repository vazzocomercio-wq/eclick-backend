-- ============================================================
-- F10 ML Listing Center IA — L2 Sprint 4: Automação de preço + Catálogo
-- ml_listing_pricing_automation: status de automação ML por item.
-- Card CATALOG_ELIGIBLE não precisa de tabela — usa catalog_product_id
-- já em cache em ml_listing_pricing_suggestions (Sprint 3).
-- Spec canônica: docs/ml-listing-center-spec.md
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ml_listing_pricing_automation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  seller_id BIGINT NOT NULL,
  ml_item_id TEXT NOT NULL,
  product_id UUID REFERENCES public.products(id),

  -- Regras disponíveis (do /rules)
  available_rules JSONB DEFAULT '[]'::jsonb,
  -- [{"rule_id":"INT"},{"rule_id":"INT_EXT"}]

  -- Automação ativa (do /automation)
  is_automated BOOLEAN DEFAULT false,
  active_rule TEXT,                          -- INT, INT_EXT
  automation_status TEXT CHECK (automation_status IN ('ACTIVE', 'PAUSED')),
  pause_cause TEXT,                          -- status_detail.cause
  pause_message TEXT,                        -- status_detail.message

  -- Configuração da automação
  min_price NUMERIC,
  max_price NUMERIC,

  -- Recomendação interna
  internal_recommendation TEXT CHECK (internal_recommendation IN (
    'activate', 'configure_limits', 'review_pause', 'unpause',
    'no_action', 'consider_disable'
  )),
  recommendation_reason TEXT,

  -- IMPORTANTE: a partir de 18/03/2026 ML bloqueia edição de preço
  -- via API quando automação está ativa (status=ACTIVE)
  blocks_manual_edit BOOLEAN DEFAULT false,

  raw_rules_response JSONB,
  raw_automation_response JSONB,

  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '12 hours'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pricing_auto_org_seller
  ON public.ml_listing_pricing_automation(organization_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_pricing_auto_item
  ON public.ml_listing_pricing_automation(ml_item_id);
CREATE INDEX IF NOT EXISTS idx_pricing_auto_active
  ON public.ml_listing_pricing_automation(is_automated)
  WHERE is_automated = true;
CREATE INDEX IF NOT EXISTS idx_pricing_auto_recommendation
  ON public.ml_listing_pricing_automation(internal_recommendation)
  WHERE internal_recommendation IN ('activate', 'configure_limits', 'review_pause');
CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_auto_unique
  ON public.ml_listing_pricing_automation(organization_id, seller_id, ml_item_id);

GRANT ALL ON public.ml_listing_pricing_automation TO service_role;
GRANT SELECT ON public.ml_listing_pricing_automation TO authenticated;

NOTIFY pgrst, 'reload schema';
