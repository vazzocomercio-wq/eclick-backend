-- Faturador F1 — Fundação fiscal. Config de NF-e por empresa (CNPJ) + dados
-- fiscais por produto. NÃO emite ainda (F2+). O certificado A1 vive no painel do
-- PROVEDOR (NFe.io/Focus/etc.) — aqui guardamos só o token (em api_credentials,
-- criptografado). Regra de % de compra e venda por empresa (define o valor das notas).

-- ── Config fiscal por empresa ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fiscal_company_config (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  company_id           uuid NOT NULL REFERENCES public.fulfillment_companies(id) ON DELETE CASCADE,

  provider             text CHECK (provider IN ('nfeio','focusnfe','plugnotas','erp_externo')),
  environment          text NOT NULL DEFAULT 'homologacao' CHECK (environment IN ('homologacao','producao')),
  has_provider_token   boolean NOT NULL DEFAULT false,   -- token real vive em api_credentials (provider, key_name=company_id)
  provider_company_ref text,                             -- id da empresa no provedor (quando aplicável)

  inscricao_estadual   text,
  regime_tributario    text CHECK (regime_tributario IN ('simples','presumido','real')),
  cnae                 text,
  fiscal_address       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {street,number,complement,district,city,city_ibge,uf,zip}

  -- regra de valor das notas — PADRÃO da empresa (cada conta pode sobrescrever)
  invoice_sale_pct     numeric NOT NULL DEFAULT 100,     -- % do valor da venda (revendedora→consumidor / direto)
  invoice_purchase_pct numeric NOT NULL DEFAULT 100,     -- % do valor de compra (matriz→revendedora, na triangulação)

  certificate_status   text NOT NULL DEFAULT 'pending' CHECK (certificate_status IN ('pending','uploaded','expired')),
  certificate_expires_at timestamptz,

  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_fiscal_company_config_org ON public.fiscal_company_config(organization_id);

-- % de faturamento POR CONTA (plataforma × conta). Sobrescreve o padrão da
-- empresa quando preenchido (null = usa o padrão de fiscal_company_config).
ALTER TABLE public.fulfillment_accounts
  ADD COLUMN IF NOT EXISTS invoice_sale_pct     numeric,
  ADD COLUMN IF NOT EXISTS invoice_purchase_pct numeric;

-- ── Dados fiscais por produto ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.product_fiscal (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  ncm             text,                 -- classificação fiscal do produto (8 díg.)
  cest            text,
  origem          text,                 -- 0=nacional, 1=importado direto, etc.
  cfop_sale       text,                 -- venda → consumidor
  cfop_transfer   text,                 -- transferência/venda matriz→revendedora (triangular)
  cst_csosn       text,                 -- situação tributária (CST p/ normal, CSOSN p/ Simples)
  unit            text NOT NULL DEFAULT 'UN',
  tax_rate        numeric,              -- alíquota ICMS opcional
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_product_fiscal_org ON public.product_fiscal(organization_id);

COMMENT ON TABLE public.fiscal_company_config IS
  'Faturador F1: config de NF-e por empresa (CNPJ). Token do provedor vive em api_credentials. % define valor das notas.';

-- touch
DROP TRIGGER IF EXISTS trg_fiscal_company_config_touch ON public.fiscal_company_config;
CREATE TRIGGER trg_fiscal_company_config_touch BEFORE UPDATE ON public.fiscal_company_config
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_touch();
DROP TRIGGER IF EXISTS trg_product_fiscal_touch ON public.product_fiscal;
CREATE TRIGGER trg_product_fiscal_touch BEFORE UPDATE ON public.product_fiscal
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_touch();

-- RLS + GRANTs (padrão da casa)
DO $$
DECLARE t text; tbls text[] := ARRAY['fiscal_company_config','product_fiscal'];
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
