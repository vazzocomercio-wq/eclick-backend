-- F12 Fulfillment — Onda A: multi-empresa (CNPJ) + multi-conta + timing real das plataformas.
--
-- Cria a dimensão de EMPRESA (CNPJ emissor) e CONTA (conta de canal/marketplace),
-- e guarda no pedido o prazo REAL de despacho/entrega vindo da plataforma (ML lead_time).
-- Fundação pro painel tempo real (Onda B), tela "aguardando coleta" (Onda C),
-- NF-e (Onda D) e, no futuro, o faturador dropship triangular.

-- ── Empresas (CNPJs) ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fulfillment_companies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  cnpj            text,                                  -- só dígitos; null até o user preencher
  role            text NOT NULL DEFAULT 'unica'
                  CHECK (role IN ('matriz','revendedora','unica')),
  is_default      boolean NOT NULL DEFAULT false,        -- empresa "padrão" criada no auto-cadastro
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- CNPJ único por org quando preenchido (NULLs distintos → vários sem CNPJ ok)
CREATE UNIQUE INDEX IF NOT EXISTS uq_fulfillment_companies_cnpj
  ON public.fulfillment_companies(organization_id, cnpj) WHERE cnpj IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fulfillment_companies_org
  ON public.fulfillment_companies(organization_id, is_active);

-- ── Contas de canal (marketplace/loja/b2b) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fulfillment_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  company_id          uuid REFERENCES public.fulfillment_companies(id) ON DELETE SET NULL,
  platform            text NOT NULL,                     -- 'mercadolivre','shopee','loja','b2b'
  external_account_id text NOT NULL,                     -- seller_id (ML) / slug da loja / 'b2b'
  label               text,                              -- apelido (nickname do ML, etc.)
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, platform, external_account_id)
);
CREATE INDEX IF NOT EXISTS idx_fulfillment_accounts_org
  ON public.fulfillment_accounts(organization_id, platform);
CREATE INDEX IF NOT EXISTS idx_fulfillment_accounts_company
  ON public.fulfillment_accounts(company_id);

-- ── Pedido: dimensão (conta/empresa) + timing real da plataforma ────────────
ALTER TABLE public.fulfillment_orders
  ADD COLUMN IF NOT EXISTS account_id                uuid REFERENCES public.fulfillment_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS company_id                uuid REFERENCES public.fulfillment_companies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS platform_handling_deadline timestamptz,  -- prazo de DESPACHO/postagem (ML estimated_handling_limit)
  ADD COLUMN IF NOT EXISTS platform_delivery_deadline timestamptz,  -- prazo de ENTREGA ao cliente (ML estimated_delivery_limit)
  ADD COLUMN IF NOT EXISTS logistic_type             text,          -- self_service(Flex)/cross_docking/xd_drop_off/fulfillment(Full)
  ADD COLUMN IF NOT EXISTS shipment_id               text,          -- id do envio na plataforma
  ADD COLUMN IF NOT EXISTS scheduled_pickup_from      timestamptz,  -- janela de coleta (Flex)
  ADD COLUMN IF NOT EXISTS scheduled_pickup_to        timestamptz;

CREATE INDEX IF NOT EXISTS idx_fulfillment_orders_account
  ON public.fulfillment_orders(organization_id, account_id);
CREATE INDEX IF NOT EXISTS idx_fulfillment_orders_company
  ON public.fulfillment_orders(organization_id, company_id);
-- prazo efetivo de despacho pra varrer atrasados (real do ML quando houver)
CREATE INDEX IF NOT EXISTS idx_fulfillment_orders_handling_deadline
  ON public.fulfillment_orders(organization_id, platform_handling_deadline);

COMMENT ON COLUMN public.fulfillment_orders.platform_handling_deadline IS
  'Prazo REAL de despacho/postagem da plataforma (ML lead_time.estimated_handling_limit). Dispara "atrasado".';

-- ── touch (updated_at) ──────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_fulfillment_companies_touch ON public.fulfillment_companies;
CREATE TRIGGER trg_fulfillment_companies_touch BEFORE UPDATE ON public.fulfillment_companies
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_touch();
DROP TRIGGER IF EXISTS trg_fulfillment_accounts_touch ON public.fulfillment_accounts;
CREATE TRIGGER trg_fulfillment_accounts_touch BEFORE UPDATE ON public.fulfillment_accounts
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_touch();

-- ── RLS + GRANTs (padrão da casa) ───────────────────────────────────────────
DO $$
DECLARE t text; tbls text[] := ARRAY['fulfillment_companies','fulfillment_accounts'];
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
