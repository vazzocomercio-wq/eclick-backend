-- ============================================================
-- ML Atendimento Pós-venda IA — MVP 1
-- ============================================================
-- 5 tabelas + triggers + RLS multi-tenant
--
-- Convenções alinhadas com o resto do schema do SaaS:
--   - organization_id (não org_id)
--   - membership via organization_members
--   - RLS: 1 policy SELECT + 1 policy ALL com WITH CHECK
--   - timestamps: created_at + updated_at via trigger
--
-- Rollback (em ordem reversa):
--   DROP TABLE IF EXISTS ml_product_knowledge CASCADE;
--   DROP TABLE IF EXISTS ml_sla_events CASCADE;
--   DROP TABLE IF EXISTS ml_ai_suggestions CASCADE;
--   DROP TABLE IF EXISTS ml_messages CASCADE;
--   DROP TABLE IF EXISTS ml_conversations CASCADE;
--   DROP FUNCTION IF EXISTS public.ml_postsale_set_updated_at();

-- ============================================================
-- 1. Conversas pós-venda (pack_id é a chave do ML)
-- ============================================================
CREATE TABLE IF NOT EXISTS ml_conversations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id                BIGINT,
  pack_id                  BIGINT NOT NULL,
  order_id                 BIGINT,
  buyer_id                 BIGINT NOT NULL,
  buyer_nickname           TEXT,
  ml_listing_id            TEXT,
  product_title            TEXT,
  product_thumbnail        TEXT,
  status                   TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','blocked','expired','cancelled','claim_open','mediation','resolved')),
  last_message_at          TIMESTAMPTZ,
  last_buyer_message_at    TIMESTAMPTZ,
  last_seller_message_at   TIMESTAMPTZ,
  unread_count             INT NOT NULL DEFAULT 0,
  resolved_at              TIMESTAMPTZ,
  resolved_by              UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, pack_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_conv_org_status
  ON ml_conversations(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_ml_conv_unread
  ON ml_conversations(organization_id, unread_count) WHERE unread_count > 0;
CREATE INDEX IF NOT EXISTS idx_ml_conv_order
  ON ml_conversations(order_id);
CREATE INDEX IF NOT EXISTS idx_ml_conv_seller
  ON ml_conversations(organization_id, seller_id) WHERE seller_id IS NOT NULL;

-- ============================================================
-- 2. Mensagens individuais
-- ============================================================
CREATE TABLE IF NOT EXISTS ml_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID NOT NULL REFERENCES ml_conversations(id) ON DELETE CASCADE,
  ml_message_id     TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('buyer','seller')),
  text              TEXT NOT NULL,
  attachments       JSONB NOT NULL DEFAULT '[]'::jsonb,
  sent_at           TIMESTAMPTZ NOT NULL,
  received_at       TIMESTAMPTZ,
  read_at           TIMESTAMPTZ,
  moderation_status TEXT,
  raw               JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, ml_message_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_msg_conv
  ON ml_messages(conversation_id, sent_at DESC);

-- ============================================================
-- 3. Classificação + sugestão da IA por mensagem
-- ============================================================
CREATE TABLE IF NOT EXISTS ml_ai_suggestions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id          UUID NOT NULL REFERENCES ml_messages(id) ON DELETE CASCADE,
  conversation_id     UUID NOT NULL REFERENCES ml_conversations(id) ON DELETE CASCADE,
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Classificação
  intent              TEXT,
  sentiment           TEXT,
  urgency             TEXT,
  risk                TEXT,
  can_auto_reply      BOOLEAN NOT NULL DEFAULT false,

  -- Sugestão
  suggested_text      TEXT,
  suggested_chars     INT,

  -- Metadados LLM
  llm_provider        TEXT,
  llm_model           TEXT,
  llm_input_tokens    INT,
  llm_output_tokens   INT,
  llm_cost_usd        NUMERIC(10,6),
  llm_latency_ms      INT,
  llm_fallback_used   BOOLEAN NOT NULL DEFAULT false,

  -- Ação humana
  action              TEXT CHECK (action IN ('sent_as_is','sent_edited','rejected','pending')),
  final_text          TEXT,
  acted_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  acted_at            TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_sug_conv ON ml_ai_suggestions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ml_sug_msg  ON ml_ai_suggestions(message_id);
CREATE INDEX IF NOT EXISTS idx_ml_sug_pending
  ON ml_ai_suggestions(organization_id, action) WHERE action IS NULL OR action = 'pending';

-- ============================================================
-- 4. Eventos de SLA (snapshot por janela)
-- ============================================================
CREATE TABLE IF NOT EXISTS ml_sla_events (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id          UUID NOT NULL REFERENCES ml_conversations(id) ON DELETE CASCADE,
  organization_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  buyer_message_id         UUID REFERENCES ml_messages(id) ON DELETE SET NULL,
  state                    TEXT NOT NULL
    CHECK (state IN ('green','yellow','orange','red','critical','resolved')),
  business_hours_elapsed   NUMERIC(6,2),
  computed_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_sla_conv
  ON ml_sla_events(conversation_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_sla_state
  ON ml_sla_events(organization_id, state) WHERE state IN ('orange','red','critical');

-- ============================================================
-- 5. Base de conhecimento por produto (texto livre, povoamento manual)
-- ============================================================
CREATE TABLE IF NOT EXISTS ml_product_knowledge (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id         UUID REFERENCES products(id) ON DELETE CASCADE,
  ml_listing_id      TEXT,
  manual             TEXT,
  problemas_comuns   TEXT,
  garantia           TEXT,
  politica_troca     TEXT,
  observacoes        TEXT,
  updated_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique parcial: 1 KB por (org, product_id) quando product_id existe;
-- senão 1 por (org, ml_listing_id). Permite co-existência.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ml_kb_org_product
  ON ml_product_knowledge(organization_id, product_id)
  WHERE product_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ml_kb_org_listing
  ON ml_product_knowledge(organization_id, ml_listing_id)
  WHERE ml_listing_id IS NOT NULL AND product_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_ml_kb_org ON ml_product_knowledge(organization_id);

-- ============================================================
-- 6. Trigger compartilhado pra updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION public.ml_postsale_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ml_conv_updated ON ml_conversations;
CREATE TRIGGER trg_ml_conv_updated BEFORE UPDATE ON ml_conversations
  FOR EACH ROW EXECUTE FUNCTION public.ml_postsale_set_updated_at();

DROP TRIGGER IF EXISTS trg_ml_kb_updated ON ml_product_knowledge;
CREATE TRIGGER trg_ml_kb_updated BEFORE UPDATE ON ml_product_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.ml_postsale_set_updated_at();

-- ============================================================
-- 7. RLS multi-tenant (1 SELECT + 1 ALL com WITH CHECK)
-- ============================================================
ALTER TABLE ml_conversations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_messages         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_ai_suggestions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_sla_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_product_knowledge ENABLE ROW LEVEL SECURITY;

-- ml_conversations
DROP POLICY IF EXISTS ml_conv_select ON ml_conversations;
CREATE POLICY ml_conv_select ON ml_conversations FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS ml_conv_modify ON ml_conversations;
CREATE POLICY ml_conv_modify ON ml_conversations FOR ALL TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ))
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

-- ml_messages (acesso via conversation_id)
DROP POLICY IF EXISTS ml_msg_select ON ml_messages;
CREATE POLICY ml_msg_select ON ml_messages FOR SELECT TO authenticated
  USING (conversation_id IN (
    SELECT id FROM ml_conversations WHERE organization_id IN (
      SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
    )
  ));
DROP POLICY IF EXISTS ml_msg_modify ON ml_messages;
CREATE POLICY ml_msg_modify ON ml_messages FOR ALL TO authenticated
  USING (conversation_id IN (
    SELECT id FROM ml_conversations WHERE organization_id IN (
      SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
    )
  ))
  WITH CHECK (conversation_id IN (
    SELECT id FROM ml_conversations WHERE organization_id IN (
      SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
    )
  ));

-- ml_ai_suggestions (organization_id direto pra performance)
DROP POLICY IF EXISTS ml_sug_select ON ml_ai_suggestions;
CREATE POLICY ml_sug_select ON ml_ai_suggestions FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS ml_sug_modify ON ml_ai_suggestions;
CREATE POLICY ml_sug_modify ON ml_ai_suggestions FOR ALL TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ))
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

-- ml_sla_events
DROP POLICY IF EXISTS ml_sla_select ON ml_sla_events;
CREATE POLICY ml_sla_select ON ml_sla_events FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS ml_sla_modify ON ml_sla_events;
CREATE POLICY ml_sla_modify ON ml_sla_events FOR ALL TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ))
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

-- ml_product_knowledge
DROP POLICY IF EXISTS ml_kb_select ON ml_product_knowledge;
CREATE POLICY ml_kb_select ON ml_product_knowledge FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS ml_kb_modify ON ml_product_knowledge;
CREATE POLICY ml_kb_modify ON ml_product_knowledge FOR ALL TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ))
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));
