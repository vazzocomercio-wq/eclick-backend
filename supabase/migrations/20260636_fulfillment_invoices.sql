-- F12 Fulfillment — Onda D: preparação de NF-e + validação de conferência fiscal.
--
-- Estrutura PRONTA pra emissão de NF-e (ainda NÃO emite — provedor decidido depois).
-- Permite MÚLTIPLAS notas por pedido (modelo dropship triangular: matriz→revendedora
-- + revendedora→consumidor). A validação compara os itens da nota com o que foi
-- SEPARADO (pick_tasks) — a "trava" antes de liberar a coleta.

CREATE TABLE IF NOT EXISTS public.fulfillment_invoices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  fulfillment_order_id uuid NOT NULL REFERENCES public.fulfillment_orders(id) ON DELETE CASCADE,
  company_id           uuid REFERENCES public.fulfillment_companies(id) ON DELETE SET NULL,  -- empresa emissora

  kind                 text NOT NULL DEFAULT 'venda'        -- venda(→consumidor)/transferencia(matriz→revendedora)/devolucao/outra
                       CHECK (kind IN ('venda','transferencia','devolucao','outra')),
  status               text NOT NULL DEFAULT 'draft'        -- draft(rascunho)/issued(emitida)/cancelled
                       CHECK (status IN ('draft','issued','cancelled')),

  -- dados fiscais (preenchidos quando emitir; nulos no rascunho)
  number               text,
  series               text,
  access_key           text,                                -- chave de acesso (44 díg.)
  danfe_url            text,
  xml_url              text,
  provider             text,                                -- focus_nfe / nfe_io / plugnotas / erp_externo… (null por enquanto)
  issued_at            timestamptz,

  -- itens que a nota cobre: [{ sku, description, qty, unit_value? }]
  items                jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- validação itens da nota × separado (pick_tasks)
  validation_status    text NOT NULL DEFAULT 'not_checked'
                       CHECK (validation_status IN ('not_checked','match','mismatch')),
  validation_diff      jsonb,                               -- [{ sku, invoiceQty, pickedQty, ok }]
  validated_at         timestamptz,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- chave de acesso única por org quando preenchida
CREATE UNIQUE INDEX IF NOT EXISTS uq_fulfillment_invoices_key
  ON public.fulfillment_invoices(organization_id, access_key) WHERE access_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fulfillment_invoices_order
  ON public.fulfillment_invoices(fulfillment_order_id);
CREATE INDEX IF NOT EXISTS idx_fulfillment_invoices_org
  ON public.fulfillment_invoices(organization_id, status);

COMMENT ON TABLE public.fulfillment_invoices IS
  'F12 Onda D: NF-e (preparação, não emite ainda). Múltiplas por pedido (dropship triangular). validation_* compara itens da nota × separado.';

DROP TRIGGER IF EXISTS trg_fulfillment_invoices_touch ON public.fulfillment_invoices;
CREATE TRIGGER trg_fulfillment_invoices_touch BEFORE UPDATE ON public.fulfillment_invoices
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_touch();

-- RLS + GRANTs (padrão da casa)
DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.fulfillment_invoices ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS fulfillment_invoices_org_all ON public.fulfillment_invoices';
  EXECUTE 'CREATE POLICY fulfillment_invoices_org_all ON public.fulfillment_invoices FOR ALL TO public USING (organization_id IN (SELECT get_user_org_ids())) WITH CHECK (organization_id IN (SELECT get_user_org_ids()))';
  EXECUTE 'DROP POLICY IF EXISTS fulfillment_invoices_srv ON public.fulfillment_invoices';
  EXECUTE 'CREATE POLICY fulfillment_invoices_srv ON public.fulfillment_invoices FOR ALL TO service_role USING (true) WITH CHECK (true)';
  EXECUTE 'GRANT ALL ON TABLE public.fulfillment_invoices TO service_role';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.fulfillment_invoices TO authenticated';
END $$;
