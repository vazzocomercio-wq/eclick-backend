-- Sessão 2026-05-18 — Sincronização de catálogo de fornecedor dropship (Cinderella/Icarus).
-- 3 partes:
--   1. supplier_catalog_items — staging do catálogo externo puxado do ERP (Pennacorp).
--      A tela de sincronização lista daqui; "sincronizar" casa por SKU (ou cria produto
--      novo) e gera o vínculo em supplier_products.
--   2. suppliers — desconto geral do fornecedor (% ou R$ fixo) sobre o preço de venda dele.
--   3. supplier_products — preço bruto do fornecedor + ajuste de custo por produto
--      (% / R$ fixo / preço manual). unit_cost passa a ser o custo LÍQUIDO calculado.

-- ── 1. Staging do catálogo externo ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.supplier_catalog_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  supplier_id        uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  integration_id     uuid REFERENCES public.supplier_integrations(id) ON DELETE SET NULL,
  -- Identificadores no ERP do fornecedor
  external_code      text NOT NULL,                  -- pt_code (vira o SKU no nosso lado)
  external_barcode   text,                           -- pb_codbar (GTIN)
  -- Dados cadastrais
  name               text,                           -- pt_descr
  family             text,                           -- fa_nome
  family_number      integer,                        -- fa_number
  unit               text,                           -- pt_unid
  image_url          text,                           -- pt_imagem
  -- Preço e estoque do fornecedor (como o fornecedor informa — nunca alterado por nós)
  gross_price        numeric,                        -- preco_final (preço de venda do fornecedor)
  original_price     numeric,                        -- preco_original (antes de promo dele)
  promo_active       boolean NOT NULL DEFAULT false,  -- pt_marg_flag = 'T'
  stock              numeric NOT NULL DEFAULT 0,      -- pt_qtd (disponível)
  -- Payload bruto pra auditoria / campos futuros
  raw                jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Vínculo: produto do nosso catálogo casado/criado a partir deste item
  matched_product_id uuid REFERENCES public.products(id) ON DELETE SET NULL,
  sync_status        text NOT NULL DEFAULT 'pending'
                       CHECK (sync_status IN ('pending','synced','ignored')),
  synced_at          timestamptz,
  last_seen_at       timestamptz NOT NULL DEFAULT now(),  -- última vez que veio no pull
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- 1 linha por (fornecedor, código externo)
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_catalog_unique
  ON public.supplier_catalog_items (supplier_id, external_code);

CREATE INDEX IF NOT EXISTS idx_supplier_catalog_org_status
  ON public.supplier_catalog_items (organization_id, supplier_id, sync_status);

CREATE INDEX IF NOT EXISTS idx_supplier_catalog_matched
  ON public.supplier_catalog_items (matched_product_id)
  WHERE matched_product_id IS NOT NULL;

ALTER TABLE public.supplier_catalog_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sci_select ON public.supplier_catalog_items;
CREATE POLICY sci_select ON public.supplier_catalog_items
  FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS sci_service ON public.supplier_catalog_items;
CREATE POLICY sci_service ON public.supplier_catalog_items
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Tabela criada via _admin_exec_sql não herda default privileges — GRANT explícito.
GRANT ALL ON public.supplier_catalog_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_catalog_items TO authenticated;

COMMENT ON TABLE public.supplier_catalog_items IS
  'Staging do catálogo de fornecedores dropship (puxado do ERP). A tela de sincronização lista daqui.';

-- ── 2. Desconto geral do fornecedor ─────────────────────────────────────────
ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS default_cost_adjustment_type text
    CHECK (default_cost_adjustment_type IN ('percent','fixed')),
  ADD COLUMN IF NOT EXISTS default_cost_adjustment_value numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.suppliers.default_cost_adjustment_type IS
  'Desconto geral sobre o preço do fornecedor: percent (%) ou fixed (R$). Aplica a todo supplier_product sem ajuste próprio.';

-- ── 3. Preço do fornecedor + ajuste de custo por produto ────────────────────
ALTER TABLE public.supplier_products
  ADD COLUMN IF NOT EXISTS supplier_gross_price numeric,
  ADD COLUMN IF NOT EXISTS cost_adjustment_type text
    CHECK (cost_adjustment_type IN ('percent','fixed','override')),
  ADD COLUMN IF NOT EXISTS cost_adjustment_value numeric;

COMMENT ON COLUMN public.supplier_products.supplier_gross_price IS
  'Preço de venda do fornecedor (bruto, como ele informa). unit_cost = este valor menos o ajuste.';
COMMENT ON COLUMN public.supplier_products.cost_adjustment_type IS
  'Ajuste de custo deste produto: percent (%), fixed (R$) ou override (custo digitado direto). NULL = usa o desconto geral do fornecedor.';
