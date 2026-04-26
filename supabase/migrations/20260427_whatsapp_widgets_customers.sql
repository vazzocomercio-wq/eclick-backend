-- ── ATENDENTE IA — ONDA 2 (WhatsApp + Widget + Identidade Cross-Canal) ────
-- Adds: whatsapp_config, webhook_events, unified_customers, chat_widgets,
-- widget_sessions + ALTER ai_conversations with cross-channel identity cols.
-- Idempotent. Run before deploying the wave-2 backend code.

-- 1. WhatsApp Business Cloud API config (per user/account)
CREATE TABLE IF NOT EXISTS whatsapp_config (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_number_id      TEXT NOT NULL,
  business_account_id  TEXT NOT NULL,
  access_token         TEXT NOT NULL,
  verify_token         TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  display_phone        TEXT,
  display_name         TEXT,
  webhook_url          TEXT,
  is_active            BOOLEAN DEFAULT true,
  is_verified          BOOLEAN DEFAULT false,
  last_verified_at     TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_config_user
  ON whatsapp_config(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_verify_token
  ON whatsapp_config(verify_token);

-- 2. Raw log of all webhook events (debug + audit, even those that fail)
CREATE TABLE IF NOT EXISTS webhook_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel      TEXT NOT NULL,
  event_type   TEXT,
  external_id  TEXT,
  payload      JSONB NOT NULL,
  processed    BOOLEAN DEFAULT false,
  error        TEXT,
  received_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_channel
  ON webhook_events(channel, received_at DESC);

-- 3. Unified cross-channel customer profile
CREATE TABLE IF NOT EXISTS unified_customers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name        TEXT,
  phone               TEXT UNIQUE,
  email               TEXT UNIQUE,
  whatsapp_id         TEXT UNIQUE,
  ml_buyer_id         TEXT,
  shopee_buyer_id     TEXT,
  avatar_url          TEXT,
  tags                TEXT[] DEFAULT '{}',
  total_conversations INT DEFAULT 0,
  total_purchases     DECIMAL(10,2) DEFAULT 0,
  first_contact_at    TIMESTAMPTZ DEFAULT now(),
  last_contact_at     TIMESTAMPTZ DEFAULT now(),
  last_channel        TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unified_customers_phone     ON unified_customers(phone);
CREATE INDEX IF NOT EXISTS idx_unified_customers_whatsapp  ON unified_customers(whatsapp_id);
CREATE INDEX IF NOT EXISTS idx_unified_customers_ml        ON unified_customers(ml_buyer_id);

-- 4. Cross-channel identity columns on ai_conversations
ALTER TABLE ai_conversations
  ADD COLUMN IF NOT EXISTS unified_customer_id   UUID REFERENCES unified_customers(id),
  ADD COLUMN IF NOT EXISTS customer_phone        TEXT,
  ADD COLUMN IF NOT EXISTS customer_email        TEXT,
  ADD COLUMN IF NOT EXISTS customer_whatsapp_id  TEXT,
  ADD COLUMN IF NOT EXISTS external_message_ids  TEXT[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_ai_conversations_unified
  ON ai_conversations(unified_customer_id);

-- 5. Embedded chat widget config
CREATE TABLE IF NOT EXISTS chat_widgets (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  agent_id           UUID REFERENCES ai_agents(id),
  welcome_message    TEXT DEFAULT 'Olá! Como posso ajudar?',
  placeholder_text   TEXT DEFAULT 'Digite sua mensagem...',
  theme_color        TEXT DEFAULT '#00E5FF',
  position           TEXT DEFAULT 'bottom-right',
  require_name       BOOLEAN DEFAULT false,
  require_email      BOOLEAN DEFAULT false,
  require_phone      BOOLEAN DEFAULT false,
  allowed_origins    TEXT[] DEFAULT '{}',
  is_active          BOOLEAN DEFAULT true,
  widget_token       TEXT UNIQUE DEFAULT gen_random_uuid()::text,
  created_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_widgets_token ON chat_widgets(widget_token);
CREATE INDEX IF NOT EXISTS idx_chat_widgets_user  ON chat_widgets(user_id);

-- 6. Anonymous widget visitor sessions
CREATE TABLE IF NOT EXISTS widget_sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  widget_id            UUID REFERENCES chat_widgets(id) ON DELETE CASCADE,
  session_token        TEXT UNIQUE DEFAULT gen_random_uuid()::text,
  visitor_name         TEXT,
  visitor_email        TEXT,
  visitor_phone        TEXT,
  unified_customer_id  UUID REFERENCES unified_customers(id),
  conversation_id      UUID REFERENCES ai_conversations(id),
  origin_url           TEXT,
  user_agent           TEXT,
  created_at           TIMESTAMPTZ DEFAULT now(),
  last_active_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_widget_sessions_token  ON widget_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_widget_sessions_widget ON widget_sessions(widget_id);

-- 7. RLS — service_role full; authenticated reads where appropriate; anon
-- can INSERT widget_sessions and read chat_widgets for the embedded widget.
ALTER TABLE whatsapp_config    ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE unified_customers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_widgets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE widget_sessions    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS srv_wa_config  ON whatsapp_config;
DROP POLICY IF EXISTS auth_wa_config ON whatsapp_config;
CREATE POLICY srv_wa_config  ON whatsapp_config FOR ALL TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY auth_wa_config ON whatsapp_config FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS srv_webhook ON webhook_events;
CREATE POLICY srv_webhook ON webhook_events FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS srv_customers  ON unified_customers;
DROP POLICY IF EXISTS auth_customers ON unified_customers;
CREATE POLICY srv_customers  ON unified_customers FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY auth_customers ON unified_customers FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS srv_widgets  ON chat_widgets;
DROP POLICY IF EXISTS auth_widgets ON chat_widgets;
DROP POLICY IF EXISTS anon_widgets ON chat_widgets;
CREATE POLICY srv_widgets  ON chat_widgets FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY auth_widgets ON chat_widgets FOR ALL    TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY anon_widgets ON chat_widgets FOR SELECT TO anon          USING (is_active = true);

DROP POLICY IF EXISTS srv_sessions  ON widget_sessions;
DROP POLICY IF EXISTS anon_sessions ON widget_sessions;
CREATE POLICY srv_sessions  ON widget_sessions FOR ALL    TO service_role USING (true) WITH CHECK (true);
CREATE POLICY anon_sessions ON widget_sessions FOR INSERT TO anon         WITH CHECK (true);

GRANT ALL    ON whatsapp_config    TO service_role;
GRANT ALL    ON whatsapp_config    TO authenticated;
GRANT ALL    ON webhook_events     TO service_role;
GRANT ALL    ON unified_customers  TO service_role;
GRANT SELECT ON unified_customers  TO authenticated;
GRANT ALL    ON chat_widgets       TO service_role;
GRANT ALL    ON chat_widgets       TO authenticated;
GRANT SELECT ON chat_widgets       TO anon;
GRANT ALL    ON widget_sessions    TO service_role;
GRANT SELECT, INSERT ON widget_sessions TO anon;
