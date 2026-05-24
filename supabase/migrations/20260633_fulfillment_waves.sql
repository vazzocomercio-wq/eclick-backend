-- e-Click Wave IA — separação em ondas (wave picking).
--
-- Agrupa N fulfillment_orders numa ONDA. O operador faz coleta CONSOLIDADA
-- (todos os itens da onda agrupados por SKU, 1 rota) e depois SORTING
-- (distribui o coletado de volta em cada pedido). Formação manual + IA assistiva.

CREATE TABLE IF NOT EXISTS public.fulfillment_waves (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  warehouse_id    uuid REFERENCES public.warehouses(id),
  name            text,
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','released','collecting','sorting','done','cancelled')),
  assigned_to     uuid REFERENCES auth.users(id),
  created_by      uuid REFERENCES auth.users(id),
  released_at     timestamptz,
  closed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fulfillment_waves_org
  ON public.fulfillment_waves(organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.fulfillment_wave_orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  wave_id              uuid NOT NULL REFERENCES public.fulfillment_waves(id) ON DELETE CASCADE,
  fulfillment_order_id uuid NOT NULL REFERENCES public.fulfillment_orders(id) ON DELETE CASCADE,
  sorted               boolean NOT NULL DEFAULT false,  -- itens já distribuídos no pedido
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wave_id, fulfillment_order_id)
);
CREATE INDEX IF NOT EXISTS idx_fulfillment_wave_orders_wave
  ON public.fulfillment_wave_orders(wave_id);
-- 1 pedido só pode estar numa onda ativa por vez (parcial: ignora finalizadas
-- via lógica no service; aqui só o índice de busca por pedido)
CREATE INDEX IF NOT EXISTS idx_fulfillment_wave_orders_fo
  ON public.fulfillment_wave_orders(fulfillment_order_id);

-- progresso da coleta consolidada por SKU: { "<sku>": qtdColetada }
ALTER TABLE public.fulfillment_waves ADD COLUMN IF NOT EXISTS collected jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON TABLE public.fulfillment_waves IS
  'e-Click Wave IA: onda de separação (batch picking + sorting). Formação manual + IA assistiva.';

DROP TRIGGER IF EXISTS trg_fulfillment_waves_touch ON public.fulfillment_waves;
CREATE TRIGGER trg_fulfillment_waves_touch BEFORE UPDATE ON public.fulfillment_waves
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_touch();

-- RLS + GRANTs (padrão da casa)
DO $$
DECLARE t text; tbls text[] := ARRAY['fulfillment_waves','fulfillment_wave_orders'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_org_all', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO public USING (organization_id IN (SELECT get_user_org_ids())) WITH CHECK (organization_id IN (SELECT get_user_org_ids()))', t || '_org_all', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_srv', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t || '_srv', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', t);
  END LOOP;
END $$;
