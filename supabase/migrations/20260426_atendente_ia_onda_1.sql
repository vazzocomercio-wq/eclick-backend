-- ── ATENDENTE IA — ONDA 1 (FOUNDATION) ─────────────────────────────────────
-- Adds: pgvector, agent templates, module settings, knowledge embeddings,
-- agent↔knowledge link, insights cache, message quality columns, 5 templates.
-- Backwards compatible: doesn't touch ai_agents/ai_messages/ai_conversations
-- shape; only ADDs columns and new tables.

-- 1. pgvector for similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Agent templates (read-only catalog used by "Create from template" modal)
CREATE TABLE IF NOT EXISTS ai_agent_templates (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  emoji               TEXT,
  description         TEXT,
  default_prompt      TEXT,
  default_provider    TEXT DEFAULT 'anthropic',
  default_model       TEXT DEFAULT 'claude-haiku-4-5-20251001',
  always_escalate     BOOLEAN DEFAULT false,
  default_categories  TEXT[],
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- 3. Module-wide settings (singleton row id=1)
CREATE TABLE IF NOT EXISTS ai_module_settings (
  id                    INT PRIMARY KEY DEFAULT 1,
  show_cost_estimates   BOOLEAN DEFAULT false,
  classifier_provider   TEXT DEFAULT 'anthropic',
  classifier_model      TEXT DEFAULT 'claude-haiku-4-5-20251001',
  embedding_provider    TEXT DEFAULT 'openai',
  embedding_model       TEXT DEFAULT 'text-embedding-3-small',
  auto_send_threshold   INT  DEFAULT 80,
  queue_threshold       INT  DEFAULT 50,
  updated_at            TIMESTAMPTZ DEFAULT now()
);

INSERT INTO ai_module_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 4. Knowledge embeddings (vector(1536) — OpenAI text-embedding-3-small dim)
CREATE TABLE IF NOT EXISTS ai_knowledge_embeddings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_id  UUID REFERENCES ai_knowledge_base(id) ON DELETE CASCADE,
  content       TEXT NOT NULL,
  embedding     vector(1536),
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_embedding
  ON ai_knowledge_embeddings
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- 5. Knowledge stats (used-by-N, last_used_at)
ALTER TABLE ai_knowledge_base
  ADD COLUMN IF NOT EXISTS times_used    INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at  TIMESTAMPTZ;

-- 6. Agent ↔ Knowledge many-to-many (one piece of knowledge can serve N agents)
CREATE TABLE IF NOT EXISTS ai_agent_knowledge (
  agent_id      UUID REFERENCES ai_agents(id) ON DELETE CASCADE,
  knowledge_id  UUID REFERENCES ai_knowledge_base(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, knowledge_id)
);

-- 7. Insights cache (analytics-as-a-service, expires)
CREATE TABLE IF NOT EXISTS ai_insights (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT,
  data          JSONB,
  generated_at  TIMESTAMPTZ DEFAULT now(),
  expires_at    TIMESTAMPTZ
);

-- 8. Message-level quality + tracking columns
ALTER TABLE ai_messages
  ADD COLUMN IF NOT EXISTS confidence            INTEGER,
  ADD COLUMN IF NOT EXISTS decision              TEXT,
  ADD COLUMN IF NOT EXISTS knowledge_cited       UUID[],
  ADD COLUMN IF NOT EXISTS duration_ms           INTEGER,
  ADD COLUMN IF NOT EXISTS tokens_used           JSONB,
  ADD COLUMN IF NOT EXISTS sent_to_customer      BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS edited_by_human       BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS original_ai_content   TEXT;

-- 9. Seed the 5 starting templates with smart suggestions
INSERT INTO ai_agent_templates (id, name, emoji, description, default_prompt, default_model, always_escalate, default_categories) VALUES
('vendas',      'Vendas',       '🛍️', 'Especialista em pré-compra: características, preço, prazo, voltagem',
'Você é especialista em VENDAS pré-compra para a Vazzo (e-commerce de iluminação no Brasil). Sua missão: converter dúvidas em vendas com respostas claras, objetivas e cordiais.

REGRAS:
- Linguagem natural em pt-BR, tom profissional mas acolhedor
- Máximo 3-4 frases por resposta
- Sempre destaque benefícios do produto
- Nunca prometa prazo fora do que o ML/Shopee informa
- Nunca dê telefone, WhatsApp ou link externo
- Se não souber, oriente o cliente a verificar a descrição do anúncio
- Finalize com convite à compra quando fizer sentido

EXEMPLO BOM: "Olá! Sim, este modelo é bivolt e funciona em 127V e 220V. Garantia de 12 meses pelo fabricante. Disponível para envio rápido pelo Mercado Envios. Aproveite!"',
'claude-haiku-4-5-20251001', false,
ARRAY['preço', 'prazo', 'produto', 'voltagem', 'envio']),

('posvenda',    'Pós-venda',    '📦', 'Pós-compra: entrega, rastreamento, status do pedido',
'Você é especialista em PÓS-VENDA para a Vazzo. Cliente já comprou e tem dúvida sobre entrega/rastreamento/status.

REGRAS:
- Tom empático e prestativo
- Verifique o número do pedido se mencionado
- Oriente sobre prazos do Mercado Envios/Shopee
- Para problemas de entrega após o prazo, escale para humano
- Nunca minta sobre status; se não tem informação, peça pra aguardar
- Se cliente está nervoso, mantenha calma e ofereça resolução',
'claude-haiku-4-5-20251001', false,
ARRAY['entrega', 'rastreamento', 'pedido']),

('tecnico',     'Técnico',      '🛠️', 'Dúvidas técnicas: instalação, voltagem, compatibilidade',
'Você é especialista TÉCNICO em iluminação para a Vazzo. Responda dúvidas sobre instalação, voltagem, compatibilidade, especificações técnicas.

REGRAS:
- Linguagem técnica MAS acessível (cliente pode não ser eletricista)
- Sempre cite especificações exatas quando souber
- Quando recomendar instalação por profissional, seja claro
- Se a dúvida envolve risco elétrico, sempre alerte sobre profissional habilitado
- Nunca dê instruções específicas de instalação que possam causar acidente

EXEMPLOS:
"Bivolt significa que funciona em 127V e 220V automaticamente, sem precisar de chave."
"Para tetos altos acima de 3m, recomendamos instalação por eletricista profissional."',
'claude-sonnet-4-6', false,
ARRAY['voltagem', 'instalação', 'compatibilidade', 'especificação']),

('reclamacoes', 'Reclamações',  '💔', 'Reclamações sérias - SEMPRE escala para humano',
'Você é o agente de RECLAMAÇÕES da Vazzo. Sua função é APENAS:
1. Acolher o cliente com empatia (1 frase)
2. Confirmar que vai ser atendido por humano em breve
3. Pedir informações mínimas (número do pedido se ainda não tem)

NUNCA tente resolver a reclamação sozinho. NUNCA prometa nada concreto.
SEMPRE marque como ESCALATE para humano após responder.

EXEMPLO: "Lamentamos pelo ocorrido. Um especialista da nossa equipe vai entrar em contato em breve para resolver isso da melhor forma. Pode informar o número do seu pedido para agilizarmos?"',
'claude-sonnet-4-6', true,
ARRAY['reclamação', 'devolução', 'reembolso']),

('traducao',    'Tradução',     '🌐', 'Atende em outros idiomas (espanhol, inglês)',
'Você é o agente de TRADUÇÃO da Vazzo. Detecta idioma do cliente e responde no MESMO idioma.

REGRAS:
- Detecta automaticamente: pt, es, en
- Responde com mesma qualidade que em português
- Mesmo tom acolhedor da equipe
- Se cliente escreve em pt, NÃO use este agente (use Vendas/PósVenda)',
'claude-haiku-4-5-20251001', false,
ARRAY['idioma'])
ON CONFLICT (id) DO NOTHING;

-- 10. RLS — service_role full, authenticated read where appropriate
ALTER TABLE ai_agent_templates       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_module_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_knowledge_embeddings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_knowledge       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_insights              ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS srv_templates  ON ai_agent_templates;
DROP POLICY IF EXISTS auth_templates ON ai_agent_templates;
CREATE POLICY srv_templates  ON ai_agent_templates FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY auth_templates ON ai_agent_templates FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS srv_settings  ON ai_module_settings;
DROP POLICY IF EXISTS auth_settings ON ai_module_settings;
CREATE POLICY srv_settings  ON ai_module_settings FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY auth_settings ON ai_module_settings FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS srv_kb_emb ON ai_knowledge_embeddings;
CREATE POLICY srv_kb_emb ON ai_knowledge_embeddings FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS srv_kb_agent  ON ai_agent_knowledge;
DROP POLICY IF EXISTS auth_kb_agent ON ai_agent_knowledge;
CREATE POLICY srv_kb_agent  ON ai_agent_knowledge FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY auth_kb_agent ON ai_agent_knowledge FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS srv_insights  ON ai_insights;
DROP POLICY IF EXISTS auth_insights ON ai_insights;
CREATE POLICY srv_insights  ON ai_insights FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY auth_insights ON ai_insights FOR SELECT TO authenticated USING (true);

GRANT SELECT ON ai_agent_templates       TO authenticated;
GRANT ALL    ON ai_agent_templates       TO service_role;
GRANT SELECT ON ai_module_settings       TO authenticated;
GRANT ALL    ON ai_module_settings       TO service_role;
GRANT ALL    ON ai_knowledge_embeddings  TO service_role;
GRANT SELECT ON ai_knowledge_embeddings  TO authenticated;
GRANT SELECT ON ai_agent_knowledge       TO authenticated;
GRANT ALL    ON ai_agent_knowledge       TO service_role;
GRANT SELECT ON ai_insights              TO authenticated;
GRANT ALL    ON ai_insights              TO service_role;
