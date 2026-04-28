-- Pricing Intelligence Sprint P2/5 — Central de Sinais + Notificações WhatsApp
-- 3 tabelas: signals (alertas detectados), notification_settings (1 por org),
-- notifications_log (histórico de envios). RLS service_role-only.

CREATE TABLE IF NOT EXISTS pricing_signals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  product_id      UUID REFERENCES products(id) ON DELETE CASCADE,
  listing_id      TEXT,
  channel         TEXT DEFAULT 'mercadolivre',

  signal_type TEXT NOT NULL CHECK (signal_type IN (
    'decrease_price', 'increase_price',
    'do_not_touch',   'review_needed', 'low_confidence'
  )),
  trigger_id  TEXT NOT NULL,
  severity    TEXT DEFAULT 'medium' CHECK (severity IN (
    'low', 'medium', 'high', 'critical'
  )),

  title       TEXT NOT NULL,
  description TEXT,

  current_price       DECIMAL(10,2),
  suggested_price     DECIMAL(10,2),
  current_margin_pct  DECIMAL(5,2),
  min_safe_price      DECIMAL(10,2),

  signal_data           JSONB DEFAULT '{}',
  confidence_score      INT   DEFAULT 100,
  confidence_breakdown  JSONB DEFAULT '{}',

  status TEXT DEFAULT 'active' CHECK (status IN (
    'active', 'actioned', 'expired', 'auto_applied'
  )),
  actioned_at   TIMESTAMPTZ,
  actioned_by   UUID,
  action_taken  TEXT,

  notified_at         TIMESTAMPTZ,
  notification_status TEXT DEFAULT 'pending' CHECK (notification_status IN (
    'pending', 'sent', 'failed', 'skipped', 'disabled'
  )),

  expires_at  TIMESTAMPTZ DEFAULT now() + interval '48 hours',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signals_org_status
  ON pricing_signals(organization_id, status, severity);
CREATE INDEX IF NOT EXISTS idx_signals_product
  ON pricing_signals(product_id, status);
CREATE INDEX IF NOT EXISTS idx_signals_pending_notify
  ON pricing_signals(notification_status, severity)
  WHERE notification_status = 'pending' AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_signals_expires
  ON pricing_signals(expires_at) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS pricing_notification_settings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE,

  whatsapp_enabled BOOLEAN DEFAULT false,
  whatsapp_phone   TEXT,

  notify_severities    JSONB DEFAULT '["critical","high"]'::jsonb,
  notify_signal_types  JSONB DEFAULT '["decrease_price","increase_price"]'::jsonb,

  quiet_hours_start TIME    DEFAULT '22:00',
  quiet_hours_end   TIME    DEFAULT '08:00',
  notify_weekends   BOOLEAN DEFAULT false,

  group_notifications  BOOLEAN DEFAULT true,
  group_window_minutes INT     DEFAULT 15,

  max_per_hour INT DEFAULT 5,
  max_per_day  INT DEFAULT 20,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pricing_notifications_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  channel         TEXT DEFAULT 'whatsapp',
  phone           TEXT,
  signal_ids      UUID[] DEFAULT '{}',
  message_body    TEXT NOT NULL,
  status          TEXT DEFAULT 'pending' CHECK (status IN (
    'pending', 'sent', 'delivered', 'failed'
  )),
  sent_at         TIMESTAMPTZ,
  error           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notif_log_org_date
  ON pricing_notifications_log(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_settings_org
  ON pricing_notification_settings(organization_id);

ALTER TABLE pricing_signals                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_notification_settings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_notifications_log       ENABLE ROW LEVEL SECURITY;

GRANT ALL ON pricing_signals                 TO service_role;
GRANT ALL ON pricing_notification_settings   TO service_role;
GRANT ALL ON pricing_notifications_log       TO service_role;

DROP POLICY IF EXISTS srv_pricing_signals  ON pricing_signals;
DROP POLICY IF EXISTS srv_notif_settings   ON pricing_notification_settings;
DROP POLICY IF EXISTS srv_notif_log        ON pricing_notifications_log;
CREATE POLICY srv_pricing_signals  ON pricing_signals                FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_notif_settings   ON pricing_notification_settings  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_notif_log        ON pricing_notifications_log       FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO pricing_notification_settings (organization_id)
VALUES ('4ef1aabd-c209-40b0-b034-ef69dcb66833')
ON CONFLICT (organization_id) DO NOTHING;
