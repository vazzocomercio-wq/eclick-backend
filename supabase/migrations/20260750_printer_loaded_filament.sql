-- ============================================================
-- Product OS — Filamento carregado na impressora (rastreio por rolo)
--
-- Diz QUAL insumo (filamento) está montado em cada impressora. Cada
-- impressão concluída naquela máquina baixa o estoque DESSE rolo (gramas,
-- custo médio real) e soma na "sessão" dele. Trocar = fecha a sessão atual
-- e abre outra → histórico de rendimento por rolo. 100% aditivo.
-- ============================================================
CREATE TABLE IF NOT EXISTS printer_loaded_filament (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  printer_id      UUID NOT NULL REFERENCES production_printer(id) ON DELETE CASCADE,
  input_id        UUID NOT NULL REFERENCES production_input(id) ON DELETE CASCADE,
  slot            INTEGER NOT NULL DEFAULT 0,   -- bandeja AMS (0 = rolo único/externo)

  loaded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  unloaded_at  TIMESTAMPTZ,                     -- NULL = montado agora
  loaded_g     NUMERIC,                         -- estimativa do que o rolo tinha ao montar (opcional)
  consumed_g   NUMERIC NOT NULL DEFAULT 0,      -- total atribuído a esta sessão

  loaded_by   UUID,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plf_org     ON printer_loaded_filament(organization_id);
CREATE INDEX IF NOT EXISTS idx_plf_printer ON printer_loaded_filament(printer_id);
CREATE INDEX IF NOT EXISTS idx_plf_input   ON printer_loaded_filament(input_id);
-- só UMA sessão aberta por (impressora, bandeja)
CREATE UNIQUE INDEX IF NOT EXISTS ux_plf_open ON printer_loaded_filament(printer_id, slot) WHERE unloaded_at IS NULL;

DROP TRIGGER IF EXISTS trg_plf_updated ON printer_loaded_filament;
CREATE TRIGGER trg_plf_updated BEFORE UPDATE ON printer_loaded_filament
  FOR EACH ROW EXECUTE FUNCTION public.set_product_os_updated_at();

ALTER TABLE printer_loaded_filament ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plf_select ON printer_loaded_filament;
CREATE POLICY plf_select ON printer_loaded_filament FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS plf_modify ON printer_loaded_filament;
CREATE POLICY plf_modify ON printer_loaded_filament FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

GRANT ALL ON TABLE public.printer_loaded_filament TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.printer_loaded_filament TO authenticated;
