-- Composição (kit operacional) — SKU composto de N unidades de outros produtos.
-- DIFERENTE de product_kits (vitrine/merchandising IA): aqui é BOM operacional:
--   • venda do kit baixa o estoque dos COMPONENTES (não do kit);
--   • estoque físico do kit vira espelho derivado = min(componente ÷ qtd);
--   • NF-e fatura os itens componentes (exploder em CompositionService).
-- Regra: 1 nível só — um kit NÃO pode ser componente de outro kit (validado
-- no service; o CHECK abaixo só impede auto-referência).

CREATE TABLE IF NOT EXISTS public.product_components (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  kit_product_id        uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  component_product_id  uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  quantity              numeric(12,3) NOT NULL CHECK (quantity > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_id, kit_product_id, component_product_id),
  CHECK (kit_product_id <> component_product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_components_org_kit
  ON public.product_components (organization_id, kit_product_id);
-- fan-out: "quais kits contêm este componente?" (recalc em cascata)
CREATE INDEX IF NOT EXISTS idx_product_components_component
  ON public.product_components (component_product_id);

ALTER TABLE public.product_components ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_components_org_all ON public.product_components;
CREATE POLICY product_components_org_all ON public.product_components
  FOR ALL TO authenticated
  USING (organization_id IN (SELECT get_user_org_ids()))
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()));

GRANT ALL ON TABLE public.product_components TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_components TO authenticated;
