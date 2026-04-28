-- User preferences — chave/valor por usuário.
-- Usado para flags de privacidade (mask_cpf/phone/email/export) e
-- futuras preferências de UI. Defaults aplicados no nível da aplicação.

CREATE TABLE IF NOT EXISTS user_preferences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_user_preferences_user ON user_preferences(user_id);

ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
GRANT ALL ON user_preferences TO service_role;
DROP POLICY IF EXISTS srv_user_prefs ON user_preferences;
CREATE POLICY srv_user_prefs ON user_preferences FOR ALL TO service_role USING (true) WITH CHECK (true);
