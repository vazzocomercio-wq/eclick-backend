-- Sprint IH-1 — Intelligence Hub
-- 5 tabelas multi-tenant pro hub de alertas IA via WhatsApp:
--   alert_managers       — gestores cadastrados que recebem alertas
--   alert_signals        — sinais brutos gerados pelos analisadores IA
--   alert_deliveries     — rastreamento de entrega por gestor
--   alert_routing_rules  — regras (departamento → categoria de alerta)
--   alert_hub_config     — config global do hub por org
--
-- Desvio aprovado vs spec original: alert_managers ganha colunas verified +
-- verification_code + verification_expires_at, status default 'pending' e
-- 'pending' no CHECK. Necessário pro fluxo /verify-phone + /confirm-phone.

-- =====================================================================
-- 1.1  alert_managers
-- =====================================================================
CREATE TABLE IF NOT EXISTS alert_managers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name            text NOT NULL,
  phone           text NOT NULL,
  department      text NOT NULL CHECK (department IN (
    'compras', 'comercial', 'marketing', 'logistica', 'diretoria'
  )),
  role            text,
  channel_id      uuid REFERENCES channels(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'active', 'paused', 'inactive'
  )),
  verified                  boolean NOT NULL DEFAULT false,
  verification_code         text,
  verification_expires_at   timestamptz,
  preferences     jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_managers_phone_org
  ON alert_managers(organization_id, phone);
CREATE INDEX IF NOT EXISTS idx_alert_managers_dept
  ON alert_managers(organization_id, department) WHERE status = 'active';

-- =====================================================================
-- 1.2  alert_signals
-- =====================================================================
CREATE TABLE IF NOT EXISTS alert_signals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  analyzer        text NOT NULL CHECK (analyzer IN (
    'compras', 'preco', 'estoque', 'margem', 'ads', 'cross_intel'
  )),
  category        text NOT NULL,
  severity        text NOT NULL DEFAULT 'info' CHECK (severity IN (
    'critical', 'warning', 'info'
  )),
  score           integer NOT NULL CHECK (score BETWEEN 0 AND 100),

  entity_type     text,
  entity_id       uuid,
  entity_name     text,

  data            jsonb NOT NULL,

  summary_pt      text NOT NULL,
  suggestion_pt   text,

  related_signals uuid[],
  cross_insight   text,

  status          text NOT NULL DEFAULT 'new' CHECK (status IN (
    'new', 'dispatched', 'delivered', 'acted', 'ignored', 'expired'
  )),
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signals_org_new
  ON alert_signals(organization_id, status, score DESC)
  WHERE status = 'new';
CREATE INDEX IF NOT EXISTS idx_signals_org_created
  ON alert_signals(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_entity
  ON alert_signals(entity_type, entity_id);

-- =====================================================================
-- 1.3  alert_deliveries
-- =====================================================================
CREATE TABLE IF NOT EXISTS alert_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  signal_id       uuid NOT NULL REFERENCES alert_signals(id) ON DELETE CASCADE,
  manager_id      uuid NOT NULL REFERENCES alert_managers(id) ON DELETE CASCADE,

  channel         text NOT NULL DEFAULT 'whatsapp' CHECK (channel IN (
    'whatsapp', 'email', 'push', 'dashboard'
  )),
  delivery_type   text NOT NULL DEFAULT 'immediate' CHECK (delivery_type IN (
    'immediate', 'digest_morning', 'digest_afternoon', 'digest_evening'
  )),

  status          text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'queued', 'sent', 'delivered', 'read', 'failed'
  )),
  sent_at         timestamptz,
  delivered_at    timestamptz,
  read_at         timestamptz,
  error_message   text,

  response_type   text CHECK (response_type IN (
    'approve', 'details', 'ignore', 'delegate', 'custom'
  )),
  response_text   text,
  response_at     timestamptz,

  wa_message_id   text,

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deliveries_manager
  ON alert_deliveries(manager_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_signal
  ON alert_deliveries(signal_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_pending
  ON alert_deliveries(status, delivery_type)
  WHERE status IN ('pending', 'queued');

-- =====================================================================
-- 1.4  alert_routing_rules
-- =====================================================================
CREATE TABLE IF NOT EXISTS alert_routing_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  department      text NOT NULL CHECK (department IN (
    'compras', 'comercial', 'marketing', 'logistica', 'diretoria'
  )),
  analyzer        text NOT NULL CHECK (analyzer IN (
    'compras', 'preco', 'estoque', 'margem', 'ads', 'cross_intel', '*'
  )),
  categories      text[] NOT NULL DEFAULT '{}',
  min_score       integer NOT NULL DEFAULT 0 CHECK (min_score BETWEEN 0 AND 100),
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_routing_rules_unique
  ON alert_routing_rules(organization_id, department, analyzer);

-- =====================================================================
-- 1.5  alert_hub_config
-- =====================================================================
CREATE TABLE IF NOT EXISTS alert_hub_config (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid UNIQUE NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  enabled         boolean NOT NULL DEFAULT false,

  analyzers_config jsonb NOT NULL DEFAULT '{
    "compras":  { "enabled": true,  "cron": "*/30 * * * *", "min_score": 20 },
    "preco":    { "enabled": true,  "cron": "0 */2 * * *",  "min_score": 20 },
    "estoque":  { "enabled": true,  "cron": "*/15 * * * *", "min_score": 20 },
    "margem":   { "enabled": true,  "cron": "0 8,14 * * *", "min_score": 20 },
    "ads":      { "enabled": true,  "cron": "0 */3 * * *",  "min_score": 20 }
  }'::jsonb,

  digest_config   jsonb NOT NULL DEFAULT '{
    "morning":   "08:00",
    "afternoon": "14:00",
    "evening":   "18:00",
    "timezone":  "America/Sao_Paulo"
  }'::jsonb,

  quiet_hours     jsonb NOT NULL DEFAULT '{
    "enabled": true,
    "start": "22:00",
    "end": "07:00"
  }'::jsonb,

  cross_intel_enabled              boolean NOT NULL DEFAULT true,
  max_alerts_per_manager_per_day   integer NOT NULL DEFAULT 20,
  min_interval_minutes             integer NOT NULL DEFAULT 15,
  learning_enabled                 boolean NOT NULL DEFAULT true,
  learning_decay_days              integer NOT NULL DEFAULT 30,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 1.6  RLS + grants
-- =====================================================================
ALTER TABLE alert_managers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_signals        ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_deliveries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_routing_rules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_hub_config     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alert_managers_org ON alert_managers;
CREATE POLICY alert_managers_org ON alert_managers FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS alert_signals_org ON alert_signals;
CREATE POLICY alert_signals_org ON alert_signals FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS alert_deliveries_org ON alert_deliveries;
CREATE POLICY alert_deliveries_org ON alert_deliveries FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS alert_routing_org ON alert_routing_rules;
CREATE POLICY alert_routing_org ON alert_routing_rules FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS alert_hub_config_org ON alert_hub_config;
CREATE POLICY alert_hub_config_org ON alert_hub_config FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

GRANT ALL ON alert_managers       TO service_role;
GRANT ALL ON alert_signals        TO service_role;
GRANT ALL ON alert_deliveries     TO service_role;
GRANT ALL ON alert_routing_rules  TO service_role;
GRANT ALL ON alert_hub_config     TO service_role;
