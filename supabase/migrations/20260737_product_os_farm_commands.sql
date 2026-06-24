-- ============================================================
-- Product OS — Fase B: canal de comandos pra farm (controle remoto)
-- Comandos enfileirados; o agente busca na resposta da telemetria,
-- executa via MQTT e reporta o resultado. Aditivo: 1 tabela nova.
-- ============================================================
CREATE TABLE IF NOT EXISTS farm_command (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  printer_id      UUID NOT NULL REFERENCES production_printer(id) ON DELETE CASCADE,
  command_type TEXT NOT NULL CHECK (command_type IN ('pause','resume','stop','print','light_on','light_off')),
  payload  JSONB NOT NULL DEFAULT '{}'::jsonb,   -- print: { file_url, file_name, order_id }
  status   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','done','failed')),
  result   TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at    TIMESTAMPTZ,
  done_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_farmcmd_org     ON farm_command(organization_id);
CREATE INDEX IF NOT EXISTS idx_farmcmd_printer ON farm_command(printer_id, status);
CREATE INDEX IF NOT EXISTS idx_farmcmd_pending ON farm_command(status) WHERE status = 'pending';

ALTER TABLE farm_command ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS farmcmd_select ON farm_command;
CREATE POLICY farmcmd_select ON farm_command FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS farmcmd_modify ON farm_command;
CREATE POLICY farmcmd_modify ON farm_command FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
GRANT ALL ON TABLE public.farm_command TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.farm_command TO authenticated;
