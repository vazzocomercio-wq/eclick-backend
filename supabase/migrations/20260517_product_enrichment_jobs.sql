-- Onda 1 hybrid C — Delta 2
-- product_enrichment_jobs: tracking dedicado de batch enrichment.
--
-- Fluxo:
--   1. UI chama POST /products/enrichment-jobs com product_ids
--   2. Backend cria row status='queued'
--   3. Worker acha jobs queued, marca 'processing', drena product_ids
--      iterando enrichProduct(), atualiza progress + results + cost
--   4. UI faz polling em GET /products/enrichment-jobs/:id pra mostrar
--      progress bar
--
-- Diferente do trigger M2.2: trigger pega mudanças individuais; jobs são
-- batch explícitos. Ambos coexistem sem conflito.
--
-- Rollback: DROP TABLE IF EXISTS product_enrichment_jobs;

CREATE TABLE IF NOT EXISTS product_enrichment_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id           uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Escopo
  product_ids       uuid[] NOT NULL,
  total_count       integer NOT NULL CHECK (total_count > 0 AND total_count <= 500),
  processed_count   integer NOT NULL DEFAULT 0,
  success_count     integer NOT NULL DEFAULT 0,
  error_count       integer NOT NULL DEFAULT 0,

  -- Configuração
  options           jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Status
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'processing', 'completed', 'failed', 'cancelled'
  )),

  -- Resultados
  results           jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Custo
  total_cost_usd    numeric(10,6) NOT NULL DEFAULT 0,
  max_cost_usd      numeric(10,6) NOT NULL DEFAULT 5.000000,

  -- Erro fatal (status='failed')
  error_message     text,

  -- Timestamps
  started_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Worker pickup: jobs queued ordenados por created_at ASC
CREATE INDEX IF NOT EXISTS idx_product_enrichment_jobs_queue
  ON product_enrichment_jobs(created_at)
  WHERE status IN ('queued', 'processing');

CREATE INDEX IF NOT EXISTS idx_product_enrichment_jobs_org
  ON product_enrichment_jobs(organization_id, status, created_at DESC);

ALTER TABLE product_enrichment_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_enrichment_jobs_org ON product_enrichment_jobs;
CREATE POLICY product_enrichment_jobs_org ON product_enrichment_jobs FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));
GRANT ALL ON product_enrichment_jobs TO service_role;
