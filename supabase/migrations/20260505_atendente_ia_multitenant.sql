-- AI-1: multi-tenant fix em 9 tabelas do Atendente IA
-- Schema original (ondas 1-2) não tinha organization_id em ai_conversations,
-- ai_messages, ai_knowledge_base, ai_agent_channels, ai_agent_analytics,
-- ai_training_examples, ai_insights, ai_agent_knowledge, ai_knowledge_embeddings.
-- Isolamento dependia de cascading via ai_agents.organization_id, mas
-- queries nos services não validavam — IDOR + cross-org leak.
--
-- Backfill por dependência:
--   ai_agents.organization_id → ai_agent_channels, ai_agent_analytics,
--     ai_training_examples, ai_agent_knowledge (via agent_id direto)
--   ai_agents.organization_id → ai_knowledge_base (via ai_agent_knowledge
--     M:M; fallback agent_id legacy column)
--   ai_knowledge_base.organization_id → ai_knowledge_embeddings
--   ai_agents.organization_id → ai_conversations (via agent_id)
--   ai_conversations.organization_id → ai_messages, ai_insights

-- ─────────────────────────────────────────────────────────────────────
-- 1. ai_agent_channels
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE ai_agent_channels ADD COLUMN IF NOT EXISTS organization_id UUID;

UPDATE ai_agent_channels c SET organization_id = a.organization_id
  FROM ai_agents a WHERE a.id = c.agent_id AND c.organization_id IS NULL;

DELETE FROM ai_agent_channels WHERE organization_id IS NULL;

ALTER TABLE ai_agent_channels ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE ai_agent_channels DROP CONSTRAINT IF EXISTS ai_agent_channels_organization_id_fkey;
ALTER TABLE ai_agent_channels ADD CONSTRAINT ai_agent_channels_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_ai_agent_channels_org_channel
  ON ai_agent_channels(organization_id, channel) WHERE is_active = true;

-- ─────────────────────────────────────────────────────────────────────
-- 2. ai_agent_analytics
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE ai_agent_analytics ADD COLUMN IF NOT EXISTS organization_id UUID;

UPDATE ai_agent_analytics x SET organization_id = a.organization_id
  FROM ai_agents a WHERE a.id = x.agent_id AND x.organization_id IS NULL;

DELETE FROM ai_agent_analytics WHERE organization_id IS NULL;

ALTER TABLE ai_agent_analytics ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE ai_agent_analytics DROP CONSTRAINT IF EXISTS ai_agent_analytics_organization_id_fkey;
ALTER TABLE ai_agent_analytics ADD CONSTRAINT ai_agent_analytics_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_ai_agent_analytics_org
  ON ai_agent_analytics(organization_id);

-- ─────────────────────────────────────────────────────────────────────
-- 3. ai_training_examples
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE ai_training_examples ADD COLUMN IF NOT EXISTS organization_id UUID;

UPDATE ai_training_examples t SET organization_id = a.organization_id
  FROM ai_agents a WHERE a.id = t.agent_id AND t.organization_id IS NULL;

DELETE FROM ai_training_examples WHERE organization_id IS NULL;

ALTER TABLE ai_training_examples ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE ai_training_examples DROP CONSTRAINT IF EXISTS ai_training_examples_organization_id_fkey;
ALTER TABLE ai_training_examples ADD CONSTRAINT ai_training_examples_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_ai_training_examples_org
  ON ai_training_examples(organization_id);

-- ─────────────────────────────────────────────────────────────────────
-- 4. ai_agent_knowledge (M:M)
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE ai_agent_knowledge ADD COLUMN IF NOT EXISTS organization_id UUID;

UPDATE ai_agent_knowledge k SET organization_id = a.organization_id
  FROM ai_agents a WHERE a.id = k.agent_id AND k.organization_id IS NULL;

DELETE FROM ai_agent_knowledge WHERE organization_id IS NULL;

ALTER TABLE ai_agent_knowledge ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE ai_agent_knowledge DROP CONSTRAINT IF EXISTS ai_agent_knowledge_organization_id_fkey;
ALTER TABLE ai_agent_knowledge ADD CONSTRAINT ai_agent_knowledge_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_ai_agent_knowledge_org
  ON ai_agent_knowledge(organization_id);

-- ─────────────────────────────────────────────────────────────────────
-- 5. ai_knowledge_base — backfill via M:M (preferido) com fallback legacy agent_id
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE ai_knowledge_base ADD COLUMN IF NOT EXISTS organization_id UUID;

-- Tenta via M:M primeiro (LIMIT 1 — MIN(uuid) não existe em PG)
UPDATE ai_knowledge_base kb SET organization_id = (
  SELECT a.organization_id FROM ai_agent_knowledge ak
  JOIN ai_agents a ON a.id = ak.agent_id
  WHERE ak.knowledge_id = kb.id
  LIMIT 1
) WHERE organization_id IS NULL;

-- Fallback: legacy agent_id direto
UPDATE ai_knowledge_base kb SET organization_id = a.organization_id
  FROM ai_agents a WHERE a.id = kb.agent_id AND kb.organization_id IS NULL;

DELETE FROM ai_knowledge_base WHERE organization_id IS NULL;

ALTER TABLE ai_knowledge_base ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE ai_knowledge_base DROP CONSTRAINT IF EXISTS ai_knowledge_base_organization_id_fkey;
ALTER TABLE ai_knowledge_base ADD CONSTRAINT ai_knowledge_base_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_ai_knowledge_base_org
  ON ai_knowledge_base(organization_id);

-- ─────────────────────────────────────────────────────────────────────
-- 6. ai_knowledge_embeddings — via knowledge_id → kb.organization_id
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE ai_knowledge_embeddings ADD COLUMN IF NOT EXISTS organization_id UUID;

UPDATE ai_knowledge_embeddings e SET organization_id = kb.organization_id
  FROM ai_knowledge_base kb WHERE kb.id = e.knowledge_id AND e.organization_id IS NULL;

DELETE FROM ai_knowledge_embeddings WHERE organization_id IS NULL;

ALTER TABLE ai_knowledge_embeddings ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE ai_knowledge_embeddings DROP CONSTRAINT IF EXISTS ai_knowledge_embeddings_organization_id_fkey;
ALTER TABLE ai_knowledge_embeddings ADD CONSTRAINT ai_knowledge_embeddings_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_ai_knowledge_embeddings_org
  ON ai_knowledge_embeddings(organization_id);

-- ─────────────────────────────────────────────────────────────────────
-- 7. ai_conversations — via agent_id
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE ai_conversations ADD COLUMN IF NOT EXISTS organization_id UUID;

UPDATE ai_conversations c SET organization_id = a.organization_id
  FROM ai_agents a WHERE a.id = c.agent_id AND c.organization_id IS NULL;

DELETE FROM ai_conversations WHERE organization_id IS NULL;

ALTER TABLE ai_conversations ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE ai_conversations DROP CONSTRAINT IF EXISTS ai_conversations_organization_id_fkey;
ALTER TABLE ai_conversations ADD CONSTRAINT ai_conversations_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_ai_conversations_org_status
  ON ai_conversations(organization_id, status);

-- ─────────────────────────────────────────────────────────────────────
-- 8. ai_messages — via conversation_id → ai_conversations.organization_id
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS organization_id UUID;

UPDATE ai_messages m SET organization_id = c.organization_id
  FROM ai_conversations c WHERE c.id = m.conversation_id AND m.organization_id IS NULL;

DELETE FROM ai_messages WHERE organization_id IS NULL;

ALTER TABLE ai_messages ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE ai_messages DROP CONSTRAINT IF EXISTS ai_messages_organization_id_fkey;
ALTER TABLE ai_messages ADD CONSTRAINT ai_messages_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_ai_messages_org_conv
  ON ai_messages(organization_id, conversation_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- 9. ai_insights — schema é puro cache (id, type, data, generated_at, expires_at).
-- Não tem FK pra agent/conversation. Como é cache temporário com expires_at,
-- truncamos e re-geramos org-aware no service.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE ai_insights ADD COLUMN IF NOT EXISTS organization_id UUID;

TRUNCATE ai_insights;

ALTER TABLE ai_insights ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE ai_insights DROP CONSTRAINT IF EXISTS ai_insights_organization_id_fkey;
ALTER TABLE ai_insights ADD CONSTRAINT ai_insights_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_ai_insights_org
  ON ai_insights(organization_id);

-- ─────────────────────────────────────────────────────────────────────
-- 10. RLS + grants pra todas as 9
-- ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'ai_agent_channels','ai_agent_analytics','ai_training_examples',
      'ai_agent_knowledge','ai_knowledge_base','ai_knowledge_embeddings',
      'ai_conversations','ai_messages','ai_insights'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_org', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))',
      t || '_org', t
    );
    EXECUTE format('GRANT ALL ON %I TO service_role', t);
  END LOOP;
END $$;
