-- Lead Bridge — capture marketplace buyer contacts via QR/landing pages,
-- enrich via public-data CPF lookups, run multi-step WhatsApp journeys.
-- Run in Supabase SQL Editor before deploying the lead-bridge module.

CREATE TABLE IF NOT EXISTS lead_bridge_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  rastreio_enabled BOOLEAN DEFAULT true,
  rastreio_landing_title TEXT DEFAULT 'Acompanhe seu pedido',
  rastreio_incentive_text TEXT,
  garantia_enabled BOOLEAN DEFAULT true,
  garantia_cupom_code TEXT,
  garantia_cupom_value DECIMAL(5,2),
  garantia_months INT DEFAULT 12,
  posvenda_enabled BOOLEAN DEFAULT true,
  posvenda_thank_you_msg TEXT,
  cpf_enrichment_enabled BOOLEAN DEFAULT false,
  cpf_provider TEXT DEFAULT 'bigdatacorp',
  cpf_api_key TEXT,
  whatsapp_auto_message_enabled BOOLEAN DEFAULT true,
  whatsapp_welcome_template TEXT,
  brand_color TEXT DEFAULT '#00E5FF',
  brand_logo_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(organization_id)
);

CREATE TABLE IF NOT EXISTS lead_bridge_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('rastreio','garantia','posvenda')),
  short_token TEXT UNIQUE NOT NULL,
  order_id TEXT,
  product_sku TEXT,
  product_name TEXT,
  marketplace TEXT,
  marketplace_buyer_id TEXT,
  qr_code_url TEXT,
  printed_at TIMESTAMPTZ,
  scanned_count INT DEFAULT 0,
  last_scanned_at TIMESTAMPTZ,
  converted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_bridge_links_token ON lead_bridge_links(short_token);
CREATE INDEX IF NOT EXISTS idx_lead_bridge_links_org   ON lead_bridge_links(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lead_bridge_conversions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  link_id UUID REFERENCES lead_bridge_links(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  full_name TEXT,
  cpf TEXT,
  email TEXT,
  phone TEXT,
  whatsapp TEXT,
  birth_date DATE,
  consent_marketing  BOOLEAN DEFAULT false,
  consent_whatsapp   BOOLEAN DEFAULT false,
  consent_enrichment BOOLEAN DEFAULT false,
  consent_ip TEXT,
  consent_at TIMESTAMPTZ DEFAULT now(),
  enriched BOOLEAN DEFAULT false,
  enriched_at TIMESTAMPTZ,
  enrichment_data JSONB DEFAULT '{}',
  unified_customer_id UUID,
  journey_stage TEXT DEFAULT 'captured',
  journey_messages_sent INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_bridge_conv_org   ON lead_bridge_conversions(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_bridge_conv_phone ON lead_bridge_conversions(phone);
CREATE INDEX IF NOT EXISTS idx_lead_bridge_conv_cpf   ON lead_bridge_conversions(cpf);

CREATE TABLE IF NOT EXISTS lead_bridge_journeys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  name TEXT NOT NULL,
  trigger_channel TEXT,
  is_active BOOLEAN DEFAULT true,
  steps JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_bridge_journey_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversion_id UUID REFERENCES lead_bridge_conversions(id) ON DELETE CASCADE,
  journey_id UUID REFERENCES lead_bridge_journeys(id),
  current_step INT DEFAULT 0,
  next_step_at TIMESTAMPTZ,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE lead_bridge_configs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_bridge_links         ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_bridge_conversions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_bridge_journeys      ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_bridge_journey_runs  ENABLE ROW LEVEL SECURITY;

GRANT ALL ON lead_bridge_configs       TO service_role;
GRANT ALL ON lead_bridge_links         TO service_role;
GRANT ALL ON lead_bridge_conversions   TO service_role;
GRANT ALL ON lead_bridge_journeys      TO service_role;
GRANT ALL ON lead_bridge_journey_runs  TO service_role;

CREATE POLICY srv_lb_configs  ON lead_bridge_configs       FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_lb_links    ON lead_bridge_links         FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_lb_conv     ON lead_bridge_conversions   FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_lb_journeys ON lead_bridge_journeys      FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_lb_runs     ON lead_bridge_journey_runs  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY anon_lb_links_select ON lead_bridge_links
  FOR SELECT TO anon USING (true);
CREATE POLICY anon_lb_conv_insert  ON lead_bridge_conversions
  FOR INSERT TO anon WITH CHECK (true);
