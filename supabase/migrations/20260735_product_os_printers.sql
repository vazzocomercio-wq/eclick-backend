-- ============================================================
-- Product OS — Fase 4: Impressoras + economia da fábrica
-- Cadastro de impressora (dados + custo de aquisição) + payback
-- (lucro abate o investimento) + controle de produção por impressora.
-- Aditivo: 1 tabela nova + colunas novas (nullable) em tabelas da Fase 2.
-- ============================================================

CREATE TABLE IF NOT EXISTS production_printer (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  brand    TEXT,
  model    TEXT,
  build_volume_mm TEXT,         -- ex: "256x256x256"
  nozzle_mm       NUMERIC,
  has_ams         BOOLEAN NOT NULL DEFAULT false,
  power_watts     NUMERIC,      -- consumo médio (informativo)
  acquisition_cost NUMERIC NOT NULL DEFAULT 0,   -- custo de aquisição (investimento a quitar)
  acquisition_date DATE,
  expected_lifetime_hours NUMERIC,               -- vida útil estimada (informativo)
  status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','manutencao','aposentada')),
  notes  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_printer_org ON production_printer(organization_id);

DROP TRIGGER IF EXISTS trg_printer_updated ON production_printer;
CREATE TRIGGER trg_printer_updated BEFORE UPDATE ON production_printer
  FOR EACH ROW EXECUTE FUNCTION public.set_product_os_updated_at();

ALTER TABLE production_printer ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS printer_select ON production_printer;
CREATE POLICY printer_select ON production_printer FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS printer_modify ON production_printer;
CREATE POLICY printer_modify ON production_printer FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
GRANT ALL ON TABLE public.production_printer TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.production_printer TO authenticated;

-- vínculo da produção à impressora + snapshots de fechamento (p/ payback)
ALTER TABLE production_order
  ADD COLUMN IF NOT EXISTS printer_id          UUID REFERENCES production_printer(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unit_cost_snapshot  NUMERIC,
  ADD COLUMN IF NOT EXISTS unit_price_snapshot NUMERIC,
  ADD COLUMN IF NOT EXISTS contribution_total  NUMERIC;
CREATE INDEX IF NOT EXISTS idx_po_printer ON production_order(printer_id) WHERE printer_id IS NOT NULL;

ALTER TABLE print_job
  ADD COLUMN IF NOT EXISTS printer_id UUID REFERENCES production_printer(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pj_printer ON print_job(printer_id) WHERE printer_id IS NOT NULL;
