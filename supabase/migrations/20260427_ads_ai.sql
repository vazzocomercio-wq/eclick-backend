-- Ads AI — analytical agents for ML Ads campaigns.
-- Run in Supabase SQL Editor before deploying the ads-ai module.

CREATE TABLE IF NOT EXISTS ads_ai_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE,
  model_provider TEXT DEFAULT 'anthropic',
  model_id TEXT DEFAULT 'claude-haiku-4-5-20251001',
  acos_alert_threshold DECIMAL(5,2) DEFAULT 30.00,
  roas_min_threshold DECIMAL(5,2) DEFAULT 2.00,
  ctr_drop_threshold DECIMAL(5,2) DEFAULT 30.00,
  budget_burn_threshold DECIMAL(5,2) DEFAULT 80.00,
  stock_critical_days INT DEFAULT 7,
  whatsapp_alerts_enabled BOOLEAN DEFAULT false,
  whatsapp_alert_phone TEXT,
  whatsapp_alert_severity TEXT DEFAULT 'high',
  auto_detect_enabled BOOLEAN DEFAULT true,
  detect_cron_minutes INT DEFAULT 60,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ads_ai_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  campaign_id TEXT,
  campaign_name TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  estimated_impact TEXT,
  data_snapshot JSONB DEFAULT '{}',
  status TEXT DEFAULT 'open',
  resolved_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  alert_sent BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ads_ai_insights_org_status
  ON ads_ai_insights(organization_id, status, severity, created_at DESC);

CREATE TABLE IF NOT EXISTS ads_ai_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  user_id UUID,
  title TEXT,
  model_used TEXT,
  total_tokens INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ads_ai_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES ads_ai_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content TEXT NOT NULL,
  tool_calls JSONB,
  tool_results JSONB,
  tokens_used INT DEFAULT 0,
  cost_usd DECIMAL(10,6) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ads_ai_messages_conv
  ON ads_ai_messages(conversation_id, created_at);

ALTER TABLE ads_ai_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_ai_insights       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_ai_conversations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_ai_messages       ENABLE ROW LEVEL SECURITY;

GRANT ALL ON ads_ai_settings       TO service_role;
GRANT ALL ON ads_ai_insights       TO service_role;
GRANT ALL ON ads_ai_conversations  TO service_role;
GRANT ALL ON ads_ai_messages       TO service_role;

CREATE POLICY srv_ads_ai_settings ON ads_ai_settings       FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_ads_ai_insights ON ads_ai_insights       FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_ads_ai_conv     ON ads_ai_conversations  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_ads_ai_msg      ON ads_ai_messages       FOR ALL TO service_role USING (true) WITH CHECK (true);
