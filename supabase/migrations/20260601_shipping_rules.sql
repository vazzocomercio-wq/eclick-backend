-- Store Builder v3 — Frete polimorfico (Fase D.2).
--
-- Cada loja cadastra N regras. Quando o cliente informa CEP no checkout,
-- ShippingService roda as regras de cima pra baixo (priority ascendente)
-- e retorna as opcoes elegiveis pra ele escolher.
--
-- Kinds:
--  - fixed         → valor fixo (price_cents)
--  - free          → gratis (sem custo)
--  - percentage    → percentual do subtotal (percent_value 0..100)
--  - cep_range     → vale pra CEPs entre cep_from e cep_to (price_cents fixo)
--  - weight_based  → R$ por kg do pedido (price_per_kg_cents)
--  - melhor_envio  → integracao API (fica pra outra sprint — placeholder)
--
-- Conditions opcionais (filtram quando a regra se aplica):
--  - min_subtotal_cents / max_subtotal_cents
--  - max_weight_kg
--  - state_code (UF do CEP)

CREATE TABLE IF NOT EXISTS public.shipping_rules (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('fixed', 'free', 'percentage', 'cep_range', 'weight_based', 'melhor_envio')),
  name                 text NOT NULL,
  priority             integer NOT NULL DEFAULT 100,
  active               boolean NOT NULL DEFAULT true,

  -- Valores (uso depende do kind)
  price_cents          integer NOT NULL DEFAULT 0,   -- fixed | cep_range
  percent_value        numeric(5,2),                 -- percentage (0..100)
  price_per_kg_cents   integer,                      -- weight_based

  -- Faixa de CEP (cep_range)
  cep_from             text,
  cep_to               text,

  -- Condicoes opcionais
  min_subtotal_cents   integer,
  max_subtotal_cents   integer,
  max_weight_kg        numeric(8,3),
  state_codes          text[],   -- ['SP','RJ'] — vazio = todos

  -- Estimativa de prazo (mostrado pro cliente)
  delivery_min_days    integer,
  delivery_max_days    integer,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shipping_rules_org_active_priority_idx
  ON public.shipping_rules (organization_id, active, priority);

ALTER TABLE public.shipping_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shipping_rules_select_own ON public.shipping_rules;
CREATE POLICY shipping_rules_select_own ON public.shipping_rules FOR SELECT
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS shipping_rules_modify_own ON public.shipping_rules;
CREATE POLICY shipping_rules_modify_own ON public.shipping_rules FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ))
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

GRANT ALL ON TABLE public.shipping_rules TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.shipping_rules TO authenticated;

-- Adiciona campos de frete em storefront_orders.
ALTER TABLE public.storefront_orders
  ADD COLUMN IF NOT EXISTS shipping_rule_id uuid REFERENCES public.shipping_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS shipping_method_name text,
  ADD COLUMN IF NOT EXISTS shipping_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shipping_cep text;

COMMENT ON TABLE  public.shipping_rules IS 'Regras de frete polimorficas — 6 kinds (fixed, free, percentage, cep_range, weight_based, melhor_envio).';
