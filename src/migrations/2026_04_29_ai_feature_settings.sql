-- Sprint AI-ABS-1 — abstração multi-provider de IA. Cria tabela
-- ai_feature_settings (override per-org per-feature) e estende
-- ai_usage_log com colunas de organization_id + latency + fallback
-- pra observability adequada do LlmService.
--
-- Rollback:
--   DROP TABLE IF EXISTS ai_feature_settings;
--   ALTER TABLE ai_usage_log DROP COLUMN IF EXISTS organization_id;
--   ALTER TABLE ai_usage_log DROP COLUMN IF EXISTS latency_ms;
--   ALTER TABLE ai_usage_log DROP COLUMN IF EXISTS fallback_used;

BEGIN;

-- ── 1. ai_feature_settings — override per-org per-feature ───────────────
CREATE TABLE IF NOT EXISTS ai_feature_settings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  feature_key       text NOT NULL,
  primary_provider  text NOT NULL CHECK (primary_provider IN ('anthropic','openai')),
  primary_model     text NOT NULL,
  fallback_provider text CHECK (fallback_provider IN ('anthropic','openai')),
  fallback_model    text,
  enabled           boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, feature_key)
);

CREATE INDEX IF NOT EXISTS ai_feature_settings_org_idx
  ON ai_feature_settings (organization_id, feature_key);

ALTER TABLE ai_feature_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members ai_feature_settings" ON ai_feature_settings;
CREATE POLICY "org members ai_feature_settings" ON ai_feature_settings FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

GRANT ALL ON ai_feature_settings TO service_role;

-- ── 2. ai_usage_log — colunas faltantes pro LlmService ──────────────────
-- A tabela já existe e é usada pelo painel /configuracoes/integracoes,
-- mas faltam organization_id (multi-tenant), latency_ms (perf tracking)
-- e fallback_used (sinaliza quando primário falhou e fallback assumiu).
ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS latency_ms      integer,
  ADD COLUMN IF NOT EXISTS fallback_used   boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS ai_usage_log_org_created_idx
  ON ai_usage_log (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_usage_log_org_feature_idx
  ON ai_usage_log (organization_id, feature, created_at DESC);

COMMIT;
