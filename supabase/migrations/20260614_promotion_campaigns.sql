-- Campanhas de promoção da Loja Própria.
--
-- Permite agrupar N produtos sob 1 campanha (ex: "BLACK FRIDAY 2026")
-- com desconto padrão (% ou preço fixo) + janela start/end + badge.
-- Cada produto pode ter override individual (desconto diferente do
-- padrão da campanha).
--
-- Fluxo:
--   1. Lojista cria campanha (default_discount_pct=30, starts_at, ends_at)
--   2. Adiciona produtos (bulk)
--   3. Pode ajustar % de produto individual (override)
--   4. Clica "Aplicar campanha" → escreve sale_price em cada produto
--      respeitando override > pct default. Campos sale_start_at,
--      sale_end_at, sale_badge_text vêm da campanha.
--   5. Desativar campanha = remove sale_price dos produtos atrelados.
--
-- products.sale_price continua sendo a fonte da verdade no renderer
-- (já implementado em 20260604). Campanha é uma camada de
-- "configuração reutilizável" sobre isso.

CREATE TABLE IF NOT EXISTS public.promotion_campaigns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  name                  text NOT NULL,                       -- "BLACK FRIDAY 2026"
  description           text,                                  -- opcional, p/ admin
  default_discount_pct  numeric(5, 2) NOT NULL DEFAULT 10
                        CHECK (default_discount_pct > 0 AND default_discount_pct < 100),
  badge_text            text,                                  -- "BLACK FRIDAY", "LIQUIDA"
  starts_at             timestamptz,                           -- opcional
  ends_at               timestamptz,                           -- opcional

  active                boolean NOT NULL DEFAULT true,
  applied_at            timestamptz,                            -- quando rodou applyCampaign
  applied_count         integer NOT NULL DEFAULT 0,             -- N produtos afetados na última apply

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_promotion_campaigns_org_active
  ON public.promotion_campaigns (organization_id, active, created_at DESC);

COMMENT ON TABLE public.promotion_campaigns IS
  'Campanhas agrupando N produtos com desconto comum + override por produto.';

-- ── Produtos da campanha ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.promotion_campaign_products (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         uuid NOT NULL REFERENCES public.promotion_campaigns(id) ON DELETE CASCADE,
  product_id          uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,

  -- Override individual: se setado, vence o default da campanha
  discount_pct_override   numeric(5, 2)
                          CHECK (discount_pct_override IS NULL OR (discount_pct_override > 0 AND discount_pct_override < 100)),
  sale_price_override     numeric(12, 2)
                          CHECK (sale_price_override IS NULL OR sale_price_override > 0),

  added_at            timestamptz NOT NULL DEFAULT now()
);

-- 1 produto por campanha (não duplica)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_campaign_product
  ON public.promotion_campaign_products (campaign_id, product_id);

CREATE INDEX IF NOT EXISTS idx_campaign_products_product
  ON public.promotion_campaign_products (product_id);

COMMENT ON TABLE public.promotion_campaign_products IS
  'Produtos atrelados a uma campanha. Override individual opcional.';

-- Trigger updated_at
CREATE OR REPLACE FUNCTION public.tg_promotion_campaigns_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_promotion_campaigns_touch ON public.promotion_campaigns;
CREATE TRIGGER trg_promotion_campaigns_touch
  BEFORE UPDATE ON public.promotion_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.tg_promotion_campaigns_touch();

GRANT ALL ON TABLE public.promotion_campaigns         TO service_role;
GRANT ALL ON TABLE public.promotion_campaign_products TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promotion_campaigns         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promotion_campaign_products TO authenticated;
