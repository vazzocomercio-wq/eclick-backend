-- AI-4: ai_module_settings vira per-org.
-- Antes era singleton id=1 — todas as orgs compartilhavam thresholds,
-- providers e toggles, então uma org não podia ajustar auto_send_threshold
-- sem mexer na outra. Migration:
--   1. Adiciona organization_id (nullable inicialmente)
--   2. Backfill: a única linha existente (id=1) vira do org "primário"
--      (a primeira org cadastrada, normalmente a do usuário fundador)
--   3. Replica essa linha pra todas as outras orgs (cada org começa com
--      defaults idênticos — depois cada uma personaliza)
--   4. Drop do PRIMARY KEY antigo (id), substitui por organization_id UNIQUE
--   5. RLS: cada org só lê/escreve a sua

-- 1. organization_id column
ALTER TABLE ai_module_settings
  ADD COLUMN IF NOT EXISTS organization_id UUID;

-- 2. Atribui a org primária à linha existente (id=1)
UPDATE ai_module_settings
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1)
 WHERE organization_id IS NULL;

-- Se ainda restou alguma sem org (caso não haja organizations), drop preventivo
DELETE FROM ai_module_settings WHERE organization_id IS NULL;

-- 3. Replica a linha-template pra todas as outras orgs
INSERT INTO ai_module_settings (
  organization_id, show_cost_estimates,
  classifier_provider, classifier_model,
  embedding_provider, embedding_model,
  auto_send_threshold, queue_threshold,
  show_tokens, capture_edits, auto_retrain,
  notify_escalation, notify_daily, updated_at
)
SELECT
  o.id,
  COALESCE(s.show_cost_estimates, false),
  COALESCE(s.classifier_provider, 'anthropic'),
  COALESCE(s.classifier_model,    'claude-haiku-4-5-20251001'),
  COALESCE(s.embedding_provider,  'openai'),
  COALESCE(s.embedding_model,     'text-embedding-3-small'),
  COALESCE(s.auto_send_threshold, 80),
  COALESCE(s.queue_threshold,     50),
  COALESCE(s.show_tokens,         true),
  COALESCE(s.capture_edits,       true),
  COALESCE(s.auto_retrain,        false),
  COALESCE(s.notify_escalation,   true),
  COALESCE(s.notify_daily,        false),
  now()
FROM organizations o
LEFT JOIN LATERAL (
  SELECT * FROM ai_module_settings LIMIT 1
) s ON true
WHERE NOT EXISTS (
  SELECT 1 FROM ai_module_settings ms WHERE ms.organization_id = o.id
);

-- 4. Drop PK antigo, troca por org+id
ALTER TABLE ai_module_settings ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE ai_module_settings DROP CONSTRAINT IF EXISTS ai_module_settings_pkey;
ALTER TABLE ai_module_settings DROP CONSTRAINT IF EXISTS ai_module_settings_organization_id_key;
ALTER TABLE ai_module_settings ADD CONSTRAINT ai_module_settings_organization_id_key UNIQUE (organization_id);
ALTER TABLE ai_module_settings DROP CONSTRAINT IF EXISTS ai_module_settings_organization_id_fkey;
ALTER TABLE ai_module_settings ADD CONSTRAINT ai_module_settings_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

-- id pode continuar existindo como surrogate, mas não é mais PK. Promovemos
-- organization_id como PK funcional via UNIQUE acima.

-- 5. RLS
ALTER TABLE ai_module_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_module_settings_org ON ai_module_settings;
CREATE POLICY ai_module_settings_org ON ai_module_settings FOR ALL
  USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
GRANT ALL ON ai_module_settings TO service_role;
