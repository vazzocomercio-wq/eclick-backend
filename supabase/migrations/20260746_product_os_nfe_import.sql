-- ============================================================
-- Product OS — Importação de NF de insumo (XML)
-- Sobe o XML da NF-e de compra → cria/usa o fornecedor (suppliers) e cria/
-- abastece os insumos (production_input + movimento WAC). Esta tabela é o log
-- anti-duplicação: a mesma NF (chave de acesso) não entra estoque 2×.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.nfe_import_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  access_key       TEXT NOT NULL,                 -- chave de 44 dígitos da NF-e
  nf_number        TEXT,
  supplier_id      UUID,
  supplier_tax_id  TEXT,
  items_count      INTEGER NOT NULL DEFAULT 0,
  total_value      NUMERIC,
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, access_key)
);
CREATE INDEX IF NOT EXISTS idx_nfe_import_log_org ON public.nfe_import_log (organization_id, created_at);

ALTER TABLE public.nfe_import_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nfe_import_log_select ON public.nfe_import_log;
CREATE POLICY nfe_import_log_select ON public.nfe_import_log FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS nfe_import_log_modify ON public.nfe_import_log;
CREATE POLICY nfe_import_log_modify ON public.nfe_import_log FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

GRANT ALL ON TABLE public.nfe_import_log TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.nfe_import_log TO authenticated;
