-- Customer Intelligence Hub — Part 1/4: Enrichment service core.
-- Run in Supabase SQL Editor before deploying the enrichment module.

CREATE TABLE IF NOT EXISTS enrichment_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  provider_code TEXT NOT NULL CHECK (provider_code IN
    ('bigdatacorp','directdata','datastone','assertiva','hubdev','viacep')),
  display_name TEXT NOT NULL,
  is_enabled BOOLEAN DEFAULT false,
  api_key TEXT,
  api_secret TEXT,
  base_url TEXT,
  cost_per_query_cents INT DEFAULT 0,
  monthly_budget_brl DECIMAL(10,2),
  monthly_spent_brl DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(organization_id, provider_code)
);

CREATE TABLE IF NOT EXISTS enrichment_routing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  query_type TEXT NOT NULL CHECK (query_type IN
    ('cpf','cnpj','phone','whatsapp','email','cep')),
  primary_provider TEXT NOT NULL,
  fallback_1 TEXT,
  fallback_2 TEXT,
  fallback_3 TEXT,
  cache_ttl_days INT DEFAULT 90,
  max_retries INT DEFAULT 2,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(organization_id, query_type)
);

CREATE TABLE IF NOT EXISTS enrichment_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  query_type TEXT NOT NULL,
  query_value_hash TEXT NOT NULL,
  query_value_masked TEXT,
  provider_used TEXT NOT NULL,
  result JSONB NOT NULL,
  result_quality TEXT CHECK (result_quality IN ('full','partial','empty','error')),
  hit_count INT DEFAULT 0,
  last_hit_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_enrichment_cache_lookup
  ON enrichment_cache(organization_id, query_type, query_value_hash, expires_at);

CREATE TABLE IF NOT EXISTS enrichment_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  user_id UUID,
  query_type TEXT NOT NULL,
  query_value_masked TEXT,
  trigger_source TEXT NOT NULL,
  provider_attempts JSONB DEFAULT '[]',
  final_provider TEXT,
  final_status TEXT CHECK (final_status IN ('success','partial','failed','cached','rate_limited','no_credit')),
  duration_ms INT,
  cost_cents INT DEFAULT 0,
  cache_hit BOOLEAN DEFAULT false,
  customer_id UUID,
  order_id TEXT,
  consent_at TIMESTAMPTZ,
  consent_source TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_enrichment_log_org_date
  ON enrichment_log(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrichment_log_customer
  ON enrichment_log(customer_id);

CREATE TABLE IF NOT EXISTS enrichment_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  customer_id UUID,
  identifier_type TEXT NOT NULL,
  identifier_hash TEXT NOT NULL,
  consent_marketing BOOLEAN DEFAULT false,
  consent_enrichment BOOLEAN DEFAULT false,
  consent_messaging_whatsapp BOOLEAN DEFAULT false,
  consent_messaging_instagram BOOLEAN DEFAULT false,
  consent_messaging_tiktok BOOLEAN DEFAULT false,
  consent_source TEXT,
  consent_ip TEXT,
  consent_user_agent TEXT,
  consent_at TIMESTAMPTZ DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  UNIQUE(organization_id, identifier_hash, identifier_type)
);

CREATE INDEX IF NOT EXISTS idx_enrichment_consents_lookup
  ON enrichment_consents(organization_id, identifier_hash, identifier_type);

ALTER TABLE unified_customers
  ADD COLUMN IF NOT EXISTS enrichment_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS enrichment_quality TEXT,
  ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS enrichment_data JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS cpf TEXT,
  ADD COLUMN IF NOT EXISTS cnpj TEXT,
  ADD COLUMN IF NOT EXISTS birth_date DATE,
  ADD COLUMN IF NOT EXISTS gender TEXT,
  ADD COLUMN IF NOT EXISTS validated_email BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS validated_phone BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS validated_whatsapp BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS validated_address BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_unified_customers_cpf
  ON unified_customers(cpf) WHERE cpf IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_unified_customers_enrichment
  ON unified_customers(organization_id, enrichment_status);

ALTER TABLE enrichment_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_routing   ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_cache     ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_consents  ENABLE ROW LEVEL SECURITY;

GRANT ALL ON enrichment_providers TO service_role;
GRANT ALL ON enrichment_routing   TO service_role;
GRANT ALL ON enrichment_cache     TO service_role;
GRANT ALL ON enrichment_log       TO service_role;
GRANT ALL ON enrichment_consents  TO service_role;

CREATE POLICY srv_enr_providers ON enrichment_providers FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_enr_routing   ON enrichment_routing   FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_enr_cache     ON enrichment_cache     FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_enr_log       ON enrichment_log       FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_enr_consents  ON enrichment_consents  FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO enrichment_routing (organization_id, query_type, primary_provider, fallback_1, fallback_2)
VALUES
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833', 'cpf',      'bigdatacorp', 'directdata',  'hubdev'),
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833', 'cnpj',     'directdata',  'bigdatacorp', 'hubdev'),
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833', 'phone',    'datastone',   'assertiva',   'bigdatacorp'),
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833', 'whatsapp', 'datastone',   'assertiva',   null),
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833', 'email',    'hubdev',      'directdata',  null),
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833', 'cep',      'viacep',      'hubdev',      'directdata')
ON CONFLICT (organization_id, query_type) DO NOTHING;
