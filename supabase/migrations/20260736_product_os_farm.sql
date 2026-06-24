-- ============================================================
-- Product OS — Fase A: monitoramento da farm em tempo (quase) real
-- Agente local lê o MQTT das impressoras e envia telemetria pro backend.
-- Aditivo: 2 tabelas novas + colunas de binding na production_printer.
-- ============================================================

-- agente local registrado por org (autentica a telemetria via token)
CREATE TABLE IF NOT EXISTS farm_agent (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  token   TEXT NOT NULL,         -- segredo que o agente usa no header
  status  TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','revogado')),
  version TEXT,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_farm_agent_org   ON farm_agent(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_farm_agent_token ON farm_agent(token);

-- binding da impressora ao mundo físico
ALTER TABLE production_printer
  ADD COLUMN IF NOT EXISTS serial_number   TEXT,
  ADD COLUMN IF NOT EXISTS agent_id        UUID REFERENCES farm_agent(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lan_ip          TEXT,
  ADD COLUMN IF NOT EXISTS connection_mode TEXT DEFAULT 'lan';
CREATE INDEX IF NOT EXISTS idx_printer_serial ON production_printer(organization_id, serial_number) WHERE serial_number IS NOT NULL;

-- estado AO VIVO (1 linha por impressora, upsert pela telemetria)
CREATE TABLE IF NOT EXISTS printer_status (
  printer_id      UUID PRIMARY KEY REFERENCES production_printer(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  online   BOOLEAN NOT NULL DEFAULT false,
  state    TEXT,            -- idle | printing | paused | error | offline
  job_name TEXT,
  progress_pct     NUMERIC,
  layer_current    INTEGER,
  layer_total      INTEGER,
  nozzle_temp      NUMERIC,
  bed_temp         NUMERIC,
  remaining_minutes INTEGER,
  ams        JSONB,         -- [{slot, material, color, remain_pct}]
  error_code TEXT,
  error_text TEXT,
  raw        JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_printer_status_org ON printer_status(organization_id);

-- updated_at triggers (reusa função da Fase 1)
DROP TRIGGER IF EXISTS trg_farm_agent_updated ON farm_agent;
CREATE TRIGGER trg_farm_agent_updated BEFORE UPDATE ON farm_agent
  FOR EACH ROW EXECUTE FUNCTION public.set_product_os_updated_at();

-- RLS + grants
ALTER TABLE farm_agent     ENABLE ROW LEVEL SECURITY;
ALTER TABLE printer_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS farm_agent_select ON farm_agent;
CREATE POLICY farm_agent_select ON farm_agent FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS farm_agent_modify ON farm_agent;
CREATE POLICY farm_agent_modify ON farm_agent FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS printer_status_select ON printer_status;
CREATE POLICY printer_status_select ON printer_status FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS printer_status_modify ON printer_status;
CREATE POLICY printer_status_modify ON printer_status FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

GRANT ALL ON TABLE public.farm_agent     TO service_role;
GRANT ALL ON TABLE public.printer_status TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.farm_agent     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.printer_status TO authenticated;
