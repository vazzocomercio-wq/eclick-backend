-- ============================================================
-- Fornecedor único por CNPJ na org (importação de várias NF do mesmo
-- fornecedor não pode multiplicar o cadastro). Normaliza tax_id existente
-- (só dígitos) e crava índice único parcial. Dados já estão limpos (0 dups).
-- ============================================================
UPDATE public.suppliers SET tax_id = regexp_replace(tax_id, '\D', '', 'g')
  WHERE tax_id ~ '\D';

CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_org_taxid_uniq
  ON public.suppliers (organization_id, tax_id)
  WHERE tax_id IS NOT NULL AND tax_id <> '';
