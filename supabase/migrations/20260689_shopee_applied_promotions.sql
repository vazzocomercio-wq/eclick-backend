-- F18 Marketing inteligente — Bloco 5 (loop de outcome).
-- Registra as promoções que o e-Click APLICOU na Shopee (via /shopee/marketing/
-- apply) pra depois medir o efeito (venda na janela × baseline × custo de margem).
-- Schema shopee (já exposto ao PostgREST). Grants pro service_role (backend).

GRANT USAGE ON SCHEMA shopee TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS shopee.applied_promotions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  shop_id               bigint,
  item_id               bigint NOT NULL,
  product_id            uuid,
  vehicle               text NOT NULL DEFAULT 'discount',   -- discount/flash_sale/voucher
  discount_pct          numeric,
  effective_price       numeric,
  projected_margin_pct  numeric,
  external_id           text,                                -- discount_id da Shopee
  window_start          timestamptz,
  window_end            timestamptz,
  status                text NOT NULL DEFAULT 'active',       -- active/cancelled/ended
  applied_at            timestamptz NOT NULL DEFAULT now(),
  -- resultado medido (baseline_sales, promo_sales, lift_pct, margin_cost, verdict, measured_at)
  outcome               jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_applied_promo_org_item
  ON shopee.applied_promotions (organization_id, item_id, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_applied_promo_org_status
  ON shopee.applied_promotions (organization_id, status, applied_at DESC);

ALTER TABLE shopee.applied_promotions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members applied promo read" ON shopee.applied_promotions;
CREATE POLICY "org members applied promo read"
  ON shopee.applied_promotions FOR SELECT TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  );

GRANT ALL    ON TABLE shopee.applied_promotions TO service_role;
GRANT SELECT ON TABLE shopee.applied_promotions TO authenticated;
