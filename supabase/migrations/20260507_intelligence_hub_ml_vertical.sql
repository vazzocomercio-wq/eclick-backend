-- ============================================================
-- Intelligence Hub — Vertical ML Reputação & Alertas (MVP 2 do Pós-venda)
-- ============================================================
-- IMPORTANTE: NÃO CRIA intelligence_hub_alerts/rules/settings.
-- O Intelligence Hub do SaaS já está em prod com:
--   alert_signals, alert_routing_rules, alert_hub_config, alert_managers,
--   alert_deliveries.
-- A vertical ML adiciona apenas:
--   1) Tabelas de DOMÍNIO ML que não existem (ml_claims, reputation snapshots,
--      claim_removal_candidates).
--   2) Defaults novos em alert_routing_rules pra disparar pras 6 categorias ML.
--
-- Convenções alinhadas com o resto do schema do SaaS:
--   - organization_id NOT NULL REFERENCES organizations(id)
--   - membership via organization_members (RLS)
--   - 1 policy SELECT + 1 policy ALL com WITH CHECK
--   - timestamps via trigger ml_postsale_set_updated_at (criado na MVP 1)
--
-- Rollback (em ordem reversa):
--   DELETE FROM alert_routing_rules WHERE analyzer='ml' AND name LIKE 'ML %';
--   DROP TABLE IF EXISTS claim_removal_candidates CASCADE;
--   DROP TABLE IF EXISTS ml_seller_reputation_snapshots CASCADE;
--   DROP TABLE IF EXISTS ml_claims CASCADE;

-- ============================================================
-- 1. Reclamações ML (capturadas via webhook topic 'claims')
-- ============================================================
CREATE TABLE IF NOT EXISTS ml_claims (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ml_claim_id       BIGINT NOT NULL,
  ml_resource_id    BIGINT,                                -- order_id ou pack_id relacionado
  type              TEXT,                                  -- mediations | cancel_purchase | return | change_product | …
  stage             TEXT,                                  -- claim | mediation | dispute | closed
  status            TEXT,                                  -- opened | in_progress | closed | cancelled
  reason_id         TEXT,
  reason_name       TEXT,
  date_created      TIMESTAMPTZ NOT NULL,
  last_updated      TIMESTAMPTZ,
  conversation_id   UUID REFERENCES ml_conversations(id) ON DELETE SET NULL,
  raw               JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, ml_claim_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_claims_org_status
  ON ml_claims(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_ml_claims_stage
  ON ml_claims(organization_id, stage)
  WHERE stage IN ('mediation', 'dispute');
CREATE INDEX IF NOT EXISTS idx_ml_claims_conv
  ON ml_claims(conversation_id) WHERE conversation_id IS NOT NULL;

-- ============================================================
-- 2. Snapshots diários de reputação ML
-- ============================================================
CREATE TABLE IF NOT EXISTS ml_seller_reputation_snapshots (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id                   BIGINT NOT NULL,
  snapshot_date               DATE NOT NULL,
  level_id                    TEXT,                        -- 5_green, 4_light_green, ...
  power_seller_status         TEXT,
  total_transactions          INT,
  completed_transactions      INT,
  cancelled_transactions      INT,
  claims_rate                 NUMERIC(8,6),
  claims_count                INT,
  cancellations_rate          NUMERIC(8,6),
  cancellations_count         INT,
  delayed_handling_rate       NUMERIC(8,6),
  delayed_handling_count      INT,
  positive_ratings            NUMERIC(6,4),
  neutral_ratings             NUMERIC(6,4),
  negative_ratings            NUMERIC(6,4),
  raw                         JSONB,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, seller_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_ml_reputation_org_date
  ON ml_seller_reputation_snapshots(organization_id, snapshot_date DESC);

-- ============================================================
-- 3. Candidatos a exclusão de reclamação (regex + LLM híbrido)
-- ============================================================
CREATE TABLE IF NOT EXISTS claim_removal_candidates (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  claim_id                 UUID NOT NULL REFERENCES ml_claims(id) ON DELETE CASCADE,
  conversation_id          UUID REFERENCES ml_conversations(id) ON DELETE SET NULL,
  trigger_message_id       UUID REFERENCES ml_messages(id)       ON DELETE SET NULL,
  matched_keywords         TEXT[],
  llm_confidence           TEXT CHECK (llm_confidence IN ('low', 'medium', 'high')),
  llm_reason               TEXT,
  llm_suggested_action     TEXT,
  suggested_request_text   TEXT,
  status                   TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'dismissed', 'requested', 'approved', 'rejected')),
  dismissed_by             UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  dismissed_at             TIMESTAMPTZ,
  requested_at             TIMESTAMPTZ,
  llm_metadata             JSONB,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_removal_candidates_org_status
  ON claim_removal_candidates(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_removal_candidates_claim
  ON claim_removal_candidates(claim_id);

-- ============================================================
-- 4. Trigger updated_at em ml_claims (reusa função da MVP 1)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ml_postsale_set_updated_at') THEN
    -- Fallback: cria caso a MVP 1 não tenha rodado
    CREATE OR REPLACE FUNCTION public.ml_postsale_set_updated_at()
    RETURNS TRIGGER AS $func$
    BEGIN NEW.updated_at = now(); RETURN NEW; END;
    $func$ LANGUAGE plpgsql;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_ml_claims_updated ON ml_claims;
CREATE TRIGGER trg_ml_claims_updated BEFORE UPDATE ON ml_claims
  FOR EACH ROW EXECUTE FUNCTION public.ml_postsale_set_updated_at();

-- ============================================================
-- 5. RLS multi-tenant
-- ============================================================
ALTER TABLE ml_claims                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_seller_reputation_snapshots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_removal_candidates        ENABLE ROW LEVEL SECURITY;

-- ml_claims
DROP POLICY IF EXISTS ml_claims_select ON ml_claims;
CREATE POLICY ml_claims_select ON ml_claims FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS ml_claims_modify ON ml_claims;
CREATE POLICY ml_claims_modify ON ml_claims FOR ALL TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ))
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

-- ml_seller_reputation_snapshots
DROP POLICY IF EXISTS ml_reputation_select ON ml_seller_reputation_snapshots;
CREATE POLICY ml_reputation_select ON ml_seller_reputation_snapshots FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS ml_reputation_modify ON ml_seller_reputation_snapshots;
CREATE POLICY ml_reputation_modify ON ml_seller_reputation_snapshots FOR ALL TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ))
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

-- claim_removal_candidates
DROP POLICY IF EXISTS removal_candidates_select ON claim_removal_candidates;
CREATE POLICY removal_candidates_select ON claim_removal_candidates FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS removal_candidates_modify ON claim_removal_candidates;
CREATE POLICY removal_candidates_modify ON claim_removal_candidates FOR ALL TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ))
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

-- ============================================================
-- 6a. Estender CHECK constraint de alert_routing_rules + alert_signals
--     pra aceitar analyzer='ml'
-- ============================================================
ALTER TABLE alert_routing_rules
  DROP CONSTRAINT IF EXISTS alert_routing_rules_analyzer_check;
ALTER TABLE alert_routing_rules
  ADD CONSTRAINT alert_routing_rules_analyzer_check
  CHECK (analyzer = ANY (ARRAY[
    'compras','preco','estoque','margem','ads',
    'cross_intel','atendente_ia','ml','*'
  ]));

-- alert_signals pode ter o mesmo CHECK — extend também se existir
DO $$
DECLARE has_check boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE t.relname='alert_signals' AND n.nspname='public'
      AND c.conname='alert_signals_analyzer_check'
  ) INTO has_check;
  IF has_check THEN
    EXECUTE 'ALTER TABLE alert_signals DROP CONSTRAINT alert_signals_analyzer_check';
    EXECUTE 'ALTER TABLE alert_signals ADD CONSTRAINT alert_signals_analyzer_check ' ||
      'CHECK (analyzer = ANY (ARRAY[''compras'',''preco'',''estoque'',''margem'',''ads'',''cross_intel'',''atendente_ia'',''ml'',''*'']))';
  END IF;
END $$;

-- ============================================================
-- 6. Defaults em alert_routing_rules pras 6 categorias ML
-- ============================================================
-- Modelo public.alert_routing_rules: organization_id, department, analyzer,
-- categories[], min_score, enabled, priority.
-- (Colunas extras name/min_severity/delivery_mode/business_hours_only só
-- existem no schema 'active', não em 'public'.)
--
-- Estratégia: 1 rule por categoria ML com analyzer='ml' + categories=['<cat>'].
-- department default 'atendimento'. Customizável depois pela UI.

-- UNIQUE index (organization_id, department, analyzer): só pode existir 1
-- rule por (org, dept, analyzer), com `categories` array agrupando os tipos.
-- Pra MVP 2 ML criamos 1 rule (atendimento + ml) com as 6 categorias.
INSERT INTO alert_routing_rules
  (organization_id, department, analyzer, categories, min_score, enabled)
SELECT
  o.id,
  'atendimento',
  'ml',
  ARRAY[
    'claim_opened',
    'mediation_started',
    'shipping_delayed',
    'reputation_dropped',
    'critical_message',
    'claim_removal_candidate'
  ]::text[],
  0,
  true
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM alert_routing_rules r
  WHERE r.organization_id = o.id AND r.department='atendimento' AND r.analyzer='ml'
);
