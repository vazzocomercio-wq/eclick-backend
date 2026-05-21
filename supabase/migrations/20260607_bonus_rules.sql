-- Bônus & Brindes para Loja Própria.
--
-- 3 tipos de regra:
--  1. 'bogo'                — Buy One Get One. Cliente compra X qty do
--                              trigger_product → ganha gift_qty do MESMO
--                              produto grátis. Ex: "Leve 2 pague 1" =
--                              trigger_qty=2, gift_qty=1.
--  2. 'free_above_value'    — Pedido com subtotal >= min_subtotal_cents
--                              recebe gift_product_id de presente.
--  3. 'gift_with_product'   — Comprou trigger_qty do trigger_product →
--                              ganha gift_qty de gift_product_id.
--
-- Aplicação acontece em payments.service.revalidateItems: o backend
-- adiciona items extras com price=0 no carrinho. Frontend só EXIBE
-- (badge "🎁 LEVE 2 PAGUE 1" no card do produto trigger).
--
-- Janela: starts_at/ends_at opcionais — NULL = sem prazo.

CREATE TABLE IF NOT EXISTS public.bonus_rules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  name                text NOT NULL,
  description         text,
  type                text NOT NULL CHECK (type IN ('bogo', 'free_above_value', 'gift_with_product')),

  -- Trigger (qual condição ativa o brinde)
  trigger_product_id  uuid REFERENCES public.products(id) ON DELETE CASCADE,  -- bogo + gift_with_product
  trigger_qty         integer NOT NULL DEFAULT 2 CHECK (trigger_qty >= 1),
  min_subtotal_cents  integer DEFAULT 0,                                      -- free_above_value

  -- Brinde (o que vai de graça)
  gift_product_id     uuid REFERENCES public.products(id) ON DELETE SET NULL, -- free_above_value + gift_with_product
                                                                              -- bogo usa trigger_product como gift
  gift_qty            integer NOT NULL DEFAULT 1 CHECK (gift_qty >= 1),

  active              boolean NOT NULL DEFAULT true,
  starts_at           timestamptz,
  ends_at             timestamptz,

  -- Stats simples (incrementadas quando aplicada num pedido)
  applied_count       integer NOT NULL DEFAULT 0,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bonus_rules_org_active
  ON public.bonus_rules (organization_id, active)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_bonus_rules_trigger_product
  ON public.bonus_rules (organization_id, trigger_product_id)
  WHERE trigger_product_id IS NOT NULL AND active = true;

COMMENT ON TABLE public.bonus_rules IS
  'Regras de bônus/brindes (BOGO, brinde por valor, brinde por produto).';

-- Trigger pra updated_at
CREATE OR REPLACE FUNCTION public.tg_bonus_rules_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bonus_rules_touch ON public.bonus_rules;
CREATE TRIGGER trg_bonus_rules_touch
  BEFORE UPDATE ON public.bonus_rules
  FOR EACH ROW EXECUTE FUNCTION public.tg_bonus_rules_touch();

GRANT ALL ON TABLE public.bonus_rules TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bonus_rules TO authenticated;
