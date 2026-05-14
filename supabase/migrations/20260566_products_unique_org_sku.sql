-- Idempotência do importer de planilha: garante que (org, sku) é único
-- quando SKU está preenchido. Permite múltiplos produtos com SKU NULL
-- (catálogos legados sem código).
--
-- Sessão 2026-05-14: feature "Upload de planilha de produtos" precisa
-- detectar duplicados na hora do INSERT — sem isso, race conditions em
-- import paralelo poderiam criar 2 linhas com mesmo SKU.

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_org_sku_unique
  ON public.products (organization_id, sku)
  WHERE sku IS NOT NULL AND sku <> '';

COMMENT ON INDEX public.idx_products_org_sku_unique IS
  'Garante idempotência do importer: 1 produto por SKU por org. Permite múltiplos NULL.';

-- Tabela de auditoria de imports (1 linha por upload) — pra histórico
-- e troubleshooting. Tem RLS herdada do padrão "service role livre,
-- authenticated lê só do próprio org".
CREATE TABLE IF NOT EXISTS public.product_import_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  file_name         text,
  file_size_bytes   integer,
  rows_total        integer NOT NULL DEFAULT 0,
  rows_created      integer NOT NULL DEFAULT 0,
  rows_skipped_existing integer NOT NULL DEFAULT 0,
  rows_errors       integer NOT NULL DEFAULT 0,
  errors            jsonb NOT NULL DEFAULT '[]'::jsonb,
  column_mapping    jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_tag       text NOT NULL DEFAULT 'cadastro_pendente',
  status            text NOT NULL DEFAULT 'completed' CHECK (status IN ('processing','completed','failed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);

CREATE INDEX IF NOT EXISTS idx_product_import_batches_org_created
  ON public.product_import_batches (organization_id, created_at DESC);

ALTER TABLE public.product_import_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_import_batches_select ON public.product_import_batches;
CREATE POLICY product_import_batches_select ON public.product_import_batches
  FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS product_import_batches_service_all ON public.product_import_batches;
CREATE POLICY product_import_batches_service_all ON public.product_import_batches
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- GRANT explícito (tabelas criadas via _admin_exec_sql não recebem default privileges)
GRANT ALL ON public.product_import_batches TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_import_batches TO authenticated;

COMMENT ON TABLE public.product_import_batches IS
  'Auditoria de uploads de planilha de produtos. 1 linha por batch.';
