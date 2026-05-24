-- F12 Fulfillment — Onda E: controle de embalagens (tipos + kits) + uso por pacote.
--
-- Cadastro dos tipos de embalagem (caixa/envelope/sacola: dimensão, peso, custo,
-- estoque) e KITS (combo de materiais, ex.: "Kit Frágil" = caixa M + plástico bolha
-- + fita). O conferente registra qual embalagem usou ao fechar o pacote — base pra
-- custo de embalagem por pedido e pra sugestão de embalagem ideal.

-- ── Tipos de embalagem ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.packaging_types (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  kind            text NOT NULL DEFAULT 'caixa' CHECK (kind IN ('caixa','envelope','sacola','outro')),
  width_cm        numeric,
  height_cm       numeric,
  depth_cm        numeric,
  weight_g        numeric,                              -- peso da embalagem vazia
  cost_cents      integer,                              -- custo unitário (centavos)
  stock           integer,                              -- estoque do insumo (null = não controla)
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_packaging_types_org ON public.packaging_types(organization_id, is_active);

-- ── Kits de embalagem (combo de materiais) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.packaging_kits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  items           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ packaging_type_id, qty }]
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_packaging_kits_org ON public.packaging_kits(organization_id, is_active);

-- ── Embalagem usada no pacote ───────────────────────────────────────────────
ALTER TABLE public.pack_tasks
  ADD COLUMN IF NOT EXISTS packaging_type_id uuid REFERENCES public.packaging_types(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS packaging_kit_id  uuid REFERENCES public.packaging_kits(id)  ON DELETE SET NULL;

-- ── touch (updated_at) ──────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_packaging_types_touch ON public.packaging_types;
CREATE TRIGGER trg_packaging_types_touch BEFORE UPDATE ON public.packaging_types
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_touch();
DROP TRIGGER IF EXISTS trg_packaging_kits_touch ON public.packaging_kits;
CREATE TRIGGER trg_packaging_kits_touch BEFORE UPDATE ON public.packaging_kits
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_touch();

-- ── RLS + GRANTs (padrão da casa) ───────────────────────────────────────────
DO $$
DECLARE t text; tbls text[] := ARRAY['packaging_types','packaging_kits'];
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
