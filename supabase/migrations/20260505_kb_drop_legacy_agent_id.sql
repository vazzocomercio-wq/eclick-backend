-- AI-6: Remove a coluna legacy ai_knowledge_base.agent_id.
-- Era a referência single-agent do design original; substituída pelo M:M
-- ai_agent_knowledge. Manter as duas convivendo gerou caminhos duplos no
-- código (fallback chains, queries inconsistentes). Backfill final + drop.

-- 1. Backfill: garante que toda kb com agent_id legacy tenha entrada no M:M
INSERT INTO ai_agent_knowledge (agent_id, knowledge_id, organization_id)
SELECT kb.agent_id, kb.id, kb.organization_id
  FROM ai_knowledge_base kb
 WHERE kb.agent_id IS NOT NULL
ON CONFLICT (agent_id, knowledge_id) DO NOTHING;

-- 2. Drop column (cascade implícito pra eventual FK; não havia índice)
ALTER TABLE ai_knowledge_base DROP COLUMN IF EXISTS agent_id;
