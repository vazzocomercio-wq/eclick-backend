-- Sprint F5-3 / Batch 1 — Baileys (WhatsApp Gratuito).
-- Persiste auth state Baileys no Postgres (Railway /tmp é efêmero entre deploys).
--
-- creds  = AuthenticationCreds (object) — serializado com BufferJSON pra
--          preservar Buffer/Map binários (curve25519 keys).
-- keys   = SignalKeyStore (Map<type:id, value>) — idem.
-- Status: ciclo de vida da sessão Baileys (UI desenha o card baseado nele).

CREATE TABLE IF NOT EXISTS whatsapp_free_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_name text NOT NULL DEFAULT 'default',

  phone_number text,
  phone_name text,

  -- Auth state (use BufferJSON.replacer/reviver no worker — JSON.stringify
  -- nativo perde Buffer/Map binários e quebra a sessão silenciosamente).
  creds jsonb,
  keys  jsonb,

  status text NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('disconnected', 'connecting', 'qr_pending', 'active', 'error')),

  last_connected_at    timestamptz,
  last_disconnected_at timestamptz,
  error_message        text,

  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_id, session_name)
);

CREATE INDEX IF NOT EXISTS idx_wf_sessions_org    ON whatsapp_free_sessions(organization_id);
CREATE INDEX IF NOT EXISTS idx_wf_sessions_status ON whatsapp_free_sessions(status);
