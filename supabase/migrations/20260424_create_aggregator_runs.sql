-- Tabela de controle de execuções do agregador de vendas
CREATE TABLE IF NOT EXISTS aggregator_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_type TEXT NOT NULL CHECK (run_type IN ('backfill','daily','manual')),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','completed','failed','cancelled')),

  start_date DATE NOT NULL,
  end_date DATE NOT NULL,

  -- Progresso
  total_dates INTEGER NOT NULL,
  processed_dates INTEGER DEFAULT 0,
  current_date_processing DATE,

  -- Estatísticas
  orders_fetched INTEGER DEFAULT 0,
  orders_inserted INTEGER DEFAULT 0,
  orders_updated INTEGER DEFAULT 0,
  snapshots_inserted INTEGER DEFAULT 0,
  api_calls_made INTEGER DEFAULT 0,

  -- Timing
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  duration_seconds INTEGER,

  -- Erros
  error_message TEXT,
  error_details JSONB,

  triggered_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE aggregator_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agg_runs_org_isolation" ON aggregator_runs FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON aggregator_runs TO service_role;
GRANT SELECT ON aggregator_runs TO authenticated, anon;

CREATE INDEX idx_agg_runs_org_status
  ON aggregator_runs(organization_id, status, started_at DESC);
CREATE INDEX idx_agg_runs_active
  ON aggregator_runs(organization_id) WHERE status = 'running';
