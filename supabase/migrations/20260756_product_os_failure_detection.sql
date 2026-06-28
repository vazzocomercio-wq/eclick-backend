-- ============================================================
-- Product OS — T1-A: Detecção de falha por IA + auto-pause
--
-- A A1 roda detecção de falha ON-BOARD (spaghetti / first-layer). O agente
-- liga essa vigilância via MQTT (xcam_control_set) conforme a config por
-- impressora. Quando a impressora interrompe por falha (halt/erro), o e-Click
-- REGISTRA o evento (vira KPI de taxa de falha), garante a pausa e avisa o
-- lojista por WhatsApp com o frame da câmera. 100% aditivo.
-- ============================================================

-- (1) Config de vigilância por impressora
ALTER TABLE production_printer
  ADD COLUMN IF NOT EXISTS ai_detection_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS ai_sensitivity TEXT NOT NULL DEFAULT 'medium';  -- low | medium | high

-- (2) Eventos de falha detectada (fonte do KPI de taxa de falha)
CREATE TABLE IF NOT EXISTS printer_failure_event (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  printer_id      UUID NOT NULL REFERENCES production_printer(id) ON DELETE CASCADE,
  production_order_id UUID REFERENCES production_order(id) ON DELETE SET NULL,
  job_name        TEXT,
  source          TEXT NOT NULL DEFAULT 'bambu_native',  -- bambu_native | vision | manual
  reason          TEXT,
  error_code      TEXT,
  state           TEXT,
  camera_url      TEXT,
  auto_paused     BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID,
  false_positive  BOOLEAN NOT NULL DEFAULT FALSE,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pfe_org_printer ON printer_failure_event(organization_id, printer_id, detected_at DESC);
-- só UM alerta aberto (não reconhecido) por (impressora, job) → evita spam por ciclo de telemetria
CREATE UNIQUE INDEX IF NOT EXISTS ux_pfe_open_job ON printer_failure_event(printer_id, job_name) WHERE acknowledged_at IS NULL;

ALTER TABLE printer_failure_event ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pfe_select ON printer_failure_event;
CREATE POLICY pfe_select ON printer_failure_event FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS pfe_modify ON printer_failure_event;
CREATE POLICY pfe_modify ON printer_failure_event FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

GRANT ALL ON TABLE public.printer_failure_event TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.printer_failure_event TO authenticated;
