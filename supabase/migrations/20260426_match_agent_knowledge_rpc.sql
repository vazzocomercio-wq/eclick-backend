-- ── RPC: match_agent_knowledge ─────────────────────────────────────────────
-- Vector similarity search restricted to one agent's knowledge.
-- Used by AiKnowledgeService.searchSimilar — when missing, the service
-- falls back to a slow client-side cosine; create this for production scale.

CREATE OR REPLACE FUNCTION match_agent_knowledge(
  query_embedding vector(1536),
  match_agent_id  uuid,
  match_count     int DEFAULT 5
)
RETURNS TABLE (
  knowledge_id  uuid,
  content       text,
  score         float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    e.knowledge_id,
    e.content,
    1 - (e.embedding <=> query_embedding) AS score
  FROM ai_knowledge_embeddings e
  JOIN ai_agent_knowledge ak  ON ak.knowledge_id = e.knowledge_id
  WHERE ak.agent_id = match_agent_id
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION match_agent_knowledge TO service_role;
GRANT EXECUTE ON FUNCTION match_agent_knowledge TO authenticated;
