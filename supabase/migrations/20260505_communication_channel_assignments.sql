-- COM-2: tabela de roteamento de canal por propósito
-- Cada org configura "qual canal WhatsApp pra qual propósito".
-- baileys_channel_id (channels) XOR whatsapp_config_id (Z-API/Meta)
-- garantem 1 backend único por (org, purpose). UNIQUE (org, purpose)
-- evita ambiguidade no resolver.
--
-- Defaults sem row: ChannelRouterService aplica fallback automático
-- baseado em purpose (internal → Baileys, customer → Meta/Z-API).

CREATE TABLE IF NOT EXISTS communication_channel_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  purpose         TEXT NOT NULL CHECK (purpose IN (
    'internal_alert',         -- IH alerts, ads-ai alerts, pricing signals → equipe interna
    'manager_verification',   -- código WA pra cadastrar gestor IH
    'customer_journey',       -- pós-venda automatizada via journey
    'customer_campaign',      -- broadcasts marketing em massa
    'auth_2fa'                -- futuro: 2FA por WA
  )),

  -- Exatamente UM dos dois deve ser preenchido (XOR via CHECK)
  baileys_channel_id UUID REFERENCES channels(id)         ON DELETE SET NULL,
  whatsapp_config_id UUID REFERENCES whatsapp_config(id)  ON DELETE SET NULL,
  CONSTRAINT cca_xor_provider CHECK (
    (baileys_channel_id IS NOT NULL AND whatsapp_config_id IS NULL) OR
    (baileys_channel_id IS NULL AND whatsapp_config_id IS NOT NULL)
  ),

  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (organization_id, purpose)
);

CREATE INDEX IF NOT EXISTS idx_cca_org_purpose
  ON communication_channel_assignments(organization_id, purpose);

ALTER TABLE communication_channel_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cca_org ON communication_channel_assignments;
CREATE POLICY cca_org ON communication_channel_assignments FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

GRANT ALL ON communication_channel_assignments TO service_role;
