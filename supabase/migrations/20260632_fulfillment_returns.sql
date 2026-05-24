-- F12 Fulfillment Sprint 5 — Devoluções (returns).
--
-- Registra a reentrada de um pedido devolvido, a conferência de retorno (cada
-- item OK pra reestoque, avariado, ou descarte) e o reestoque no Estoque
-- Unificado. Itens em jsonb (resolução por item num único update).

CREATE TABLE IF NOT EXISTS public.fulfillment_returns (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  warehouse_id         uuid REFERENCES public.warehouses(id),
  fulfillment_order_id uuid REFERENCES public.fulfillment_orders(id) ON DELETE SET NULL,
  reference            text,                              -- nº amigável (pedido original / RMA)
  customer             jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason               text,
  -- [{ sku, product_id?, qty, condition: 'pending'|'restock'|'damaged'|'discard', restocked: bool }]
  items                jsonb NOT NULL DEFAULT '[]'::jsonb,
  status               text NOT NULL DEFAULT 'registered'
                       CHECK (status IN ('registered','inspecting','resolved','cancelled')),
  created_by           uuid REFERENCES auth.users(id),
  resolved_by          uuid REFERENCES auth.users(id),
  resolved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fulfillment_returns_org
  ON public.fulfillment_returns(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fulfillment_returns_order
  ON public.fulfillment_returns(fulfillment_order_id) WHERE fulfillment_order_id IS NOT NULL;

COMMENT ON TABLE public.fulfillment_returns IS
  'Devoluções (F12): reentrada de pedido devolvido + conferência de retorno + reestoque no Estoque Unificado.';

-- updated_at (reusa a função do módulo, criada na 20260627)
DROP TRIGGER IF EXISTS trg_fulfillment_returns_touch ON public.fulfillment_returns;
CREATE TRIGGER trg_fulfillment_returns_touch BEFORE UPDATE ON public.fulfillment_returns
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_touch();

-- RLS + GRANTs (padrão da casa: org-scoped + service_role + grants explícitos)
ALTER TABLE public.fulfillment_returns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fulfillment_returns_org_all ON public.fulfillment_returns;
CREATE POLICY fulfillment_returns_org_all ON public.fulfillment_returns
  FOR ALL TO public
  USING (organization_id IN (SELECT get_user_org_ids()))
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()));
DROP POLICY IF EXISTS fulfillment_returns_srv ON public.fulfillment_returns;
CREATE POLICY fulfillment_returns_srv ON public.fulfillment_returns
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT ALL ON TABLE public.fulfillment_returns TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.fulfillment_returns TO authenticated;
