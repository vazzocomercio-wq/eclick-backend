-- Sprint Active-bridge / Batch — tabela genérica de canais de comunicação.
-- Centraliza configuração de cada canal por org (whatsapp/whatsapp_free/email/insta/tiktok).
-- Para 'whatsapp_free', o auth Baileys real fica em whatsapp_free_sessions.creds/keys —
-- aqui só guardamos referência + status pro polling do worker.

CREATE TABLE IF NOT EXISTS channels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_type    text NOT NULL
    CHECK (channel_type IN ('whatsapp', 'whatsapp_free', 'email', 'instagram', 'tiktok')),
  name            text NOT NULL,
  credentials     jsonb NOT NULL DEFAULT '{}'::jsonb,
  webhook_url     text,
  webhook_secret  text,
  phone_number    text,
  external_id     text,
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'paused', 'error', 'disconnected')),
  error_message   text,
  last_webhook_at timestamptz,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channels_org ON channels(organization_id);

-- Index parcial: worker faz polling apenas de canais whatsapp_free ativos/em erro/pendentes.
CREATE INDEX IF NOT EXISTS idx_channels_polling ON channels(channel_type, status)
  WHERE channel_type = 'whatsapp_free' AND status IN ('active', 'pending', 'error');

ALTER TABLE channels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channels_org_policy ON channels;
CREATE POLICY channels_org_policy ON channels
  FOR ALL USING (
    organization_id IN (
      SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
    )
  );

-- Worker usa service_role bypass — concede acesso total.
GRANT ALL ON channels TO service_role;
