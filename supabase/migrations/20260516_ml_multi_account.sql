-- Sprint Multi-conta ML (bloco A: schema)
--
-- 1) ml_connections: UNIQUE(organization_id, seller_id) pra evitar
--    duplicatas (consultado em 06/05 — 1 row apenas, cleanup nao necessario).
--
-- 2) ml_question_suggestions: tabela cuja CREATE estava em
--    20260503_ml_question_suggestions.sql mas nunca foi aplicada em prod.
--    Consolidamos a criacao aqui + ja inclui seller_id pra discriminacao
--    de conta ML.
--
-- Rollback:
--   ALTER TABLE ml_connections DROP CONSTRAINT IF EXISTS ml_connections_org_seller_unique;
--   DROP TABLE IF EXISTS ml_question_suggestions;

-- 1. ml_connections: UNIQUE pra evitar duplicatas
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ml_connections_org_seller_unique'
  ) THEN
    ALTER TABLE ml_connections
      ADD CONSTRAINT ml_connections_org_seller_unique
      UNIQUE (organization_id, seller_id);
  END IF;
END $$;

-- 2. ml_question_suggestions: tabela + seller_id ja na criacao
CREATE TABLE IF NOT EXISTS ml_question_suggestions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id          bigint,
  question_id        text NOT NULL,
  item_id            text NOT NULL,
  question_text      text NOT NULL,
  suggested_answer   text NOT NULL,
  confidence         numeric(4,2),
  status             text DEFAULT 'pending'
    CHECK (status IN ('pending','approved','edited','sent','rejected','auto_sent')),
  final_answer       text,
  context_used       jsonb DEFAULT '{}'::jsonb,
  agent_id           uuid,
  auto_send_eligible boolean DEFAULT false,
  used_as_is         boolean,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now(),
  UNIQUE (organization_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_mlqs_org_status
  ON ml_question_suggestions(organization_id, status);

CREATE INDEX IF NOT EXISTS idx_mlqs_org_created
  ON ml_question_suggestions(organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mlqs_org_seller_status
  ON ml_question_suggestions(organization_id, seller_id, status)
  WHERE seller_id IS NOT NULL;
