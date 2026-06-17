-- 20260723_picking_carts_profile.sql
-- Regras de separação: (1) PERFIL de quantidade do pedido + (2) CARRINHO de coleta por cubagem.
--   • picking_carts = modelos de carrinho (medidas internas → volume útil). SÓ volume,
--     PESO não entra (produtos leves, carrinho pequeno — decisão do cliente).
--   • fulfillment_orders.pick_profile = single (1 item×1 un) | mono_multi (1 SKU×N) | multi (2+ itens).
--   • fulfillment_waves.cart_id + cart_plan = plano de carrinhos pré-calculado no release
--     (greedy ao longo da ROTA: cada carrinho = trecho contíguo que cabe no volume útil).
-- Medida do produto vem de products.width_cm/length_cm/height_cm (preenchida via tela de medição).

CREATE TABLE IF NOT EXISTS public.picking_carts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  warehouse_id    uuid REFERENCES public.warehouses(id) ON DELETE CASCADE,
  name            text NOT NULL,
  width_cm        numeric NOT NULL,
  length_cm       numeric NOT NULL,
  height_cm       numeric NOT NULL,
  fill_factor     numeric NOT NULL DEFAULT 0.75 CHECK (fill_factor > 0 AND fill_factor <= 1),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_picking_carts_org ON public.picking_carts (organization_id, warehouse_id);

ALTER TABLE public.fulfillment_orders ADD COLUMN IF NOT EXISTS pick_profile text;
ALTER TABLE public.fulfillment_waves  ADD COLUMN IF NOT EXISTS cart_id uuid REFERENCES public.picking_carts(id) ON DELETE SET NULL;
ALTER TABLE public.fulfillment_waves  ADD COLUMN IF NOT EXISTS cart_plan jsonb;

-- Backfill do perfil dos pedidos já existentes (a partir das tarefas de coleta).
UPDATE public.fulfillment_orders fo SET pick_profile = sub.profile
FROM (
  SELECT fulfillment_order_id,
    CASE WHEN count(*) = 1 AND max(expected_qty) = 1 THEN 'single'
         WHEN count(*) = 1 AND max(expected_qty) > 1 THEN 'mono_multi'
         ELSE 'multi' END AS profile
  FROM public.pick_tasks GROUP BY fulfillment_order_id
) sub
WHERE fo.id = sub.fulfillment_order_id AND fo.pick_profile IS NULL;

ALTER TABLE public.picking_carts ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.picking_carts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.picking_carts TO authenticated;
