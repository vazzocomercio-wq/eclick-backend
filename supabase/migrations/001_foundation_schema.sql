-- ============================================================
-- e-Click Active — Migration 001: Foundation Schema
-- Schema: active
-- Date: 2026-05-01
-- Description: Core tables, RLS policies, functions, triggers,
--              indexes for the e-Click Active CRM
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgvector";
CREATE EXTENSION IF NOT EXISTS "pg_cron";

-- Create dedicated schema
CREATE SCHEMA IF NOT EXISTS active;

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Get current user's organization ID (reuses auth.uid() from Supabase)
CREATE OR REPLACE FUNCTION active.get_user_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT org_id
  FROM active.org_members
  WHERE user_id = auth.uid()
    AND status = 'active'
  LIMIT 1;
$$;

-- Generate a URL-friendly slug from text
CREATE OR REPLACE FUNCTION active.slugify(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(regexp_replace(regexp_replace($1, '[^a-zA-Z0-9\s-]', '', 'g'), '\s+', '-', 'g'));
$$;

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION active.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ============================================================
-- 1. IDENTITY & ACCESS
-- ============================================================

-- Organizations (shared concept with e-Click SaaS)
-- If the public.organizations table already exists, this creates
-- a CRM-specific extension table. Otherwise, it's standalone.
CREATE TABLE active.organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,
  plan          text NOT NULL DEFAULT 'starter'
                CHECK (plan IN ('starter', 'professional', 'enterprise')),
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Limits based on plan (denormalized for fast checks)
  max_users     int NOT NULL DEFAULT 3,
  max_channels  int NOT NULL DEFAULT 1,
  max_pipelines int NOT NULL DEFAULT 2,
  max_automations int NOT NULL DEFAULT 5,
  -- Feature flags
  has_copilot        boolean NOT NULL DEFAULT false,
  has_audit          boolean NOT NULL DEFAULT false,
  has_erp_integration boolean NOT NULL DEFAULT false,
  -- Link to e-Click SaaS (nullable)
  saas_org_id   uuid,  -- FK to public.organizations if shared instance
  -- Timestamps
  trial_ends_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON active.organizations
  FOR EACH ROW EXECUTE FUNCTION active.set_updated_at();

-- Organization members (users within an org)
CREATE TABLE active.org_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES active.organizations(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,  -- References auth.users
  role          text NOT NULL DEFAULT 'agent'
                CHECK (role IN ('owner', 'admin', 'manager', 'agent', 'viewer')),
  workspace_ids uuid[] NOT NULL DEFAULT '{}',
  display_name  text,
  avatar_url    text,
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'invited', 'suspended')),
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id, user_id)
);

CREATE TRIGGER trg_org_members_updated_at
  BEFORE UPDATE ON active.org_members
  FOR EACH ROW EXECUTE FUNCTION active.set_updated_at();

-- Workspaces (optional sub-divisions)
CREATE TABLE active.workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES active.organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_workspaces_updated_at
  BEFORE UPDATE ON active.workspaces
  FOR EACH ROW EXECUTE FUNCTION active.set_updated_at();

-- API Keys for external integrations
CREATE TABLE active.api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES active.organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  key_hash    text NOT NULL,  -- bcrypt hash, never plain text
  key_prefix  text NOT NULL,  -- First 8 chars for identification (e.g., "eca_live_")
  scopes      text[] NOT NULL DEFAULT '{}',
  last_used_at timestamptz,
  expires_at  timestamptz,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 2. CONTACTS & COMPANIES
-- ============================================================

CREATE TABLE active.companies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES active.organizations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  domain        text,
  industry      text,
  size          text CHECK (size IN ('micro', 'small', 'medium', 'large', 'enterprise')),
  address       jsonb,  -- { street, city, state, zip, country }
  custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_companies_updated_at
  BEFORE UPDATE ON active.companies
  FOR EACH ROW EXECUTE FUNCTION active.set_updated_at();

CREATE TABLE active.contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES active.organizations(id) ON DELETE CASCADE,
  company_id    uuid REFERENCES active.companies(id) ON DELETE SET NULL,
  -- Identity
  name          text,
  phone         text,
  email         text,
  avatar_url    text,
  -- Classification
  tags          text[] NOT NULL DEFAULT '{}',
  source        text,  -- whatsapp, instagram, website, import, manual, referral
  -- AI-generated fields
  ai_summary    text,        -- Auto-generated summary of this contact
  temperature   text CHECK (temperature IN ('cold', 'warm', 'hot', 'very_hot')),
  score         int DEFAULT 0 CHECK (score >= 0 AND score <= 100),
  -- Metadata
  custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  channel_profiles jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- e.g. { "whatsapp": { "wa_id": "5571...", "profile_name": "João" }, "instagram": { "ig_id": "..." } }
  opted_out     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_contacts_updated_at
  BEFORE UPDATE ON active.contacts
  FOR EACH ROW EXECUTE FUNCTION active.set_updated_at();

-- Contact timeline (all events related to a contact)
CREATE TABLE active.contact_timeline (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES active.organizations(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL REFERENCES active.contacts(id) ON DELETE CASCADE,
  event_type  text NOT NULL,
  -- Types: message_received, message_sent, deal_created, deal_won, deal_lost,
  -- stage_changed, task_completed, note_added, tag_added, score_changed,
  -- ai_insight, channel_connected, form_submitted
  title       text,
  description text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid,  -- null = system/AI
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 3. CHANNELS
-- ============================================================

CREATE TABLE active.channels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES active.organizations(id) ON DELETE CASCADE,
  channel_type  text NOT NULL
                CHECK (channel_type IN (
                  'whatsapp', 'instagram', 'messenger', 'telegram',
                  'email', 'webchat', 'tiktok', 'mercadolivre'
                )),
  name          text NOT NULL,  -- Display name (e.g., "WhatsApp Principal")
  -- Credentials (encrypted at application level with AES-256)
  credentials   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Configuration
  webhook_url   text,
  webhook_secret text,
  phone_number  text,      -- For WhatsApp
  external_id   text,      -- Channel-specific ID (WABA ID, IG account ID, etc.)
  -- Status
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('active', 'paused', 'error', 'pending', 'disconnected')),
  error_message text,
  last_webhook_at timestamptz,
  -- Settings
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- e.g. { "auto_reply": true, "business_hours": {...}, "greeting_message": "..." }
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_channels_updated_at
  BEFORE UPDATE ON active.channels
  FOR EACH ROW EXECUTE FUNCTION active.set_updated_at();

-- Webhook event log (for debugging and replay)
CREATE TABLE active.channel_webhooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  channel_id  uuid NOT NULL REFERENCES active.channels(id) ON DELETE CASCADE,
  event_type  text,
  payload     jsonb NOT NULL,
  processed   boolean NOT NULL DEFAULT false,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 4. CONVERSATIONS & MESSAGES
-- ============================================================

CREATE TABLE active.conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES active.organizations(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES active.contacts(id) ON DELETE CASCADE,
  channel_id      uuid REFERENCES active.channels(id) ON DELETE SET NULL,
  channel_type    text NOT NULL,
  -- Status
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'pending', 'snoozed', 'resolved', 'closed')),
  priority        text NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  -- Assignment
  assigned_to     uuid,  -- org_member user_id
  team_id         uuid,  -- future: team routing
  -- Counters
  unread_count    int NOT NULL DEFAULT 0,
  message_count   int NOT NULL DEFAULT 0,
  -- AI fields
  ai_summary      text,
  ai_sentiment    text CHECK (ai_sentiment IN (
                    'very_positive', 'positive', 'neutral', 'negative', 'very_negative'
                  )),
  ai_intent       text,  -- budget, question, complaint, negotiation, support, etc.
  ai_temperature  text CHECK (ai_temperature IN ('cold', 'warm', 'hot', 'very_hot')),
  ai_next_action  text,
  -- Metadata
  tags            text[] NOT NULL DEFAULT '{}',
  custom_fields   jsonb NOT NULL DEFAULT '{}'::jsonb,
  snoozed_until   timestamptz,
  first_response_at timestamptz,
  resolved_at     timestamptz,
  last_message_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON active.conversations
  FOR EACH ROW EXECUTE FUNCTION active.set_updated_at();

-- Messages (partitioned by month for performance)
CREATE TABLE active.messages (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  conversation_id     uuid NOT NULL,
  org_id              uuid NOT NULL,
  -- Direction & sender
  direction           text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender_type         text NOT NULL CHECK (sender_type IN ('contact', 'agent', 'bot', 'system')),
  sender_id           uuid,  -- agent user_id or null for contact/bot
  -- Content (flexible JSON for any message type)
  content_type        text NOT NULL DEFAULT 'text'
                      CHECK (content_type IN (
                        'text', 'image', 'audio', 'video', 'document',
                        'template', 'location', 'sticker', 'reaction',
                        'interactive', 'system'
                      )),
  content             jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- e.g. text: { "body": "Hello" }
  -- e.g. image: { "url": "...", "caption": "...", "mime_type": "image/jpeg" }
  -- e.g. template: { "template_name": "...", "parameters": [...] }
  plain_text          text,  -- Extracted text for search (generated from content)
  -- Media
  media_url           text,
  media_mime_type     text,
  media_size_bytes    int,
  -- Channel reference
  channel_message_id  text,  -- Original ID from WhatsApp/Instagram/etc.
  -- Delivery status
  status              text NOT NULL DEFAULT 'sent'
                      CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
  error_code          text,
  error_message       text,
  -- AI analysis (populated async)
  ai_intent           text,
  ai_sentiment        text,
  -- Metadata
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- e.g. { "quoted_message_id": "...", "forwarded": true, "reaction": "👍" }
  is_internal_note    boolean NOT NULL DEFAULT false,  -- Agent-only notes
  created_at          timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

-- Create partitions for the next 12 months
DO $$
DECLARE
  start_date date := '2026-05-01';
  partition_date date;
  partition_name text;
  next_date date;
BEGIN
  FOR i IN 0..11 LOOP
    partition_date := start_date + (i || ' months')::interval;
    next_date := partition_date + '1 month'::interval;
    partition_name := 'messages_' || to_char(partition_date, 'YYYY_MM');
    
    EXECUTE format(
      'CREATE TABLE active.%I PARTITION OF active.messages
       FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      partition_date,
      next_date
    );
  END LOOP;
END $$;

-- Default partition for messages outside defined ranges
CREATE TABLE active.messages_default PARTITION OF active.messages DEFAULT;

-- Message templates (WhatsApp HSM, Instagram quick replies, etc.)
CREATE TABLE active.message_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES active.organizations(id) ON DELETE CASCADE,
  channel_type  text NOT NULL,
  name          text NOT NULL,
  category      text,  -- marketing, utility, authentication
  language      text NOT NULL DEFAULT 'pt_BR',
  content       jsonb NOT NULL,
  -- e.g. { "header": {...}, "body": "Hello {{1}}", "footer": "...", "buttons": [...] }
  variables     text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'pending', 'approved', 'rejected')),
  external_id   text,  -- WhatsApp template ID
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_message_templates_updated_at
  BEFORE UPDATE ON active.message_templates
  FOR EACH ROW EXECUTE FUNCTION active.set_updated_at();

-- ============================================================
-- 5. PIPELINES & DEALS
-- ============================================================

CREATE TABLE active.pipelines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES active.organizations(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES active.workspaces(id) ON DELETE SET NULL,
  name        text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_pipelines_updated_at
  BEFORE UPDATE ON active.pipelines
  FOR EACH ROW EXECUTE FUNCTION active.set_updated_at();

CREATE TABLE active.pipeline_stages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id     uuid NOT NULL REFERENCES active.pipelines(id) ON DELETE CASCADE,
  name            text NOT NULL,
  position        int NOT NULL DEFAULT 0,
  color           text NOT NULL DEFAULT '#00E5FF',
  probability     int NOT NULL DEFAULT 0 CHECK (probability >= 0 AND probability <= 100),
  sla_hours       int,  -- Max hours a deal should stay in this stage
  automation_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_won          boolean NOT NULL DEFAULT false,
  is_lost         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE active.deals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES active.organizations(id) ON DELETE CASCADE,
  pipeline_id         uuid NOT NULL REFERENCES active.pipelines(id) ON DELETE CASCADE,
  stage_id            uuid NOT NULL REFERENCES active.pipeline_stages(id),
  contact_id          uuid REFERENCES active.contacts(id) ON DELETE SET NULL,
  company_id          uuid REFERENCES active.companies(id) ON DELETE SET NULL,
  conversation_id     uuid REFERENCES active.conversations(id) ON DELETE SET NULL,
  -- Deal info
  title               text NOT NULL,
  value               numeric(12,2) DEFAULT 0,
  currency            text NOT NULL DEFAULT 'BRL',
  expected_close_date date,
  -- Assignment
  assigned_to         uuid,
  -- AI fields
  ai_score            int DEFAULT 0 CHECK (ai_score >= 0 AND ai_score <= 100),
  ai_risk             text CHECK (ai_risk IN ('low', 'medium', 'high', 'critical')),
  ai_next_action      text,
  ai_close_probability int CHECK (ai_close_probability >= 0 AND ai_close_probability <= 100),
  -- Result
  won_at              timestamptz,
  lost_at             timestamptz,
  lost_reason         text,
  -- Metadata
  tags                text[] NOT NULL DEFAULT '{}',
  custom_fields       jsonb NOT NULL DEFAULT '{}'::jsonb,
  position            int NOT NULL DEFAULT 0,  -- Order within stage (for drag-and-drop)
  stage_entered_at    timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_deals_updated_at
  BEFORE UPDATE ON active.deals
  FOR EACH ROW EXECUTE FUNCTION active.set_updated_at();

-- Deal activity log
CREATE TABLE active.deal_activities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  deal_id       uuid NOT NULL REFERENCES active.deals(id) ON DELETE CASCADE,
  activity_type text NOT NULL,
  -- Types: stage_changed, value_changed, assigned, note_added, task_created,
  -- email_sent, call_made, meeting_scheduled, proposal_sent, ai_insight
  title         text,
  description   text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- e.g. stage_changed: { "from": "...", "to": "...", "by": "ai" }
  created_by    uuid,  -- null = system/AI
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 6. TASKS
-- ============================================================

CREATE TABLE active.tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES active.organizations(id) ON DELETE CASCADE,
  title           text NOT NULL,
  description     text,
  task_type       text NOT NULL DEFAULT 'follow_up'
                  CHECK (task_type IN (
                    'call', 'email', 'meeting', 'follow_up', 'whatsapp',
                    'proposal', 'custom'
                  )),
  priority        text NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled', 'overdue')),
  -- Relations
  deal_id         uuid REFERENCES active.deals(id) ON DELETE SET NULL,
  contact_id      uuid REFERENCES active.contacts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES active.conversations(id) ON DELETE SET NULL,
  -- Assignment
  assigned_to     uuid NOT NULL,
  -- Scheduling
  due_date        timestamptz,
  completed_at    timestamptz,
  -- AI
  created_by_ai   boolean NOT NULL DEFAULT false,
  ai_context      text,  -- Why the AI created this task
  -- Metadata
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON active.tasks
  FOR EACH ROW EXECUTE FUNCTION active.set_updated_at();

-- ============================================================
-- 7. AUTOMATIONS
-- ============================================================

CREATE TABLE active.automations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES active.organizations(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  description           text,
  -- Trigger
  trigger_type          text NOT NULL,
  -- Types: message_received, deal_created, deal_stage_changed, contact_created,
  -- task_overdue, time_based, manual, webhook
  trigger_config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- e.g. { "channel_type": "whatsapp", "intent": "budget", "conditions": [...] }
  -- Actions (ordered array)
  actions               jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- e.g. [{ "type": "send_message", "config": {...} }, { "type": "create_task", ... }]
  -- Natural language source (for AI-created automations)
  natural_language_source text,
  -- Status
  is_active             boolean NOT NULL DEFAULT false,
  execution_count       int NOT NULL DEFAULT 0,
  last_executed_at      timestamptz,
  -- Metadata
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_automations_updated_at
  BEFORE UPDATE ON active.automations
  FOR EACH ROW EXECUTE FUNCTION active.set_updated_at();

-- Automation execution log
CREATE TABLE active.automation_logs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  automation_id     uuid NOT NULL REFERENCES active.automations(id) ON DELETE CASCADE,
  trigger_event     jsonb NOT NULL,
  actions_executed  jsonb NOT NULL DEFAULT '[]'::jsonb,
  status            text NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  error             text,
  duration_ms       int,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 8. KNOWLEDGE BASE
-- ============================================================

CREATE TABLE active.knowledge_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES active.organizations(id) ON DELETE CASCADE,
  title       text NOT NULL,
  category    text NOT NULL DEFAULT 'general',
  -- Categories: products, pricing, policies, faq, scripts, objections, procedures
  content     text NOT NULL,
  -- Vector embedding for semantic search
  embedding   vector(1536),  -- OpenAI text-embedding-3-small dimension
  -- Metadata
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active   boolean NOT NULL DEFAULT true,
  tokens      int,  -- Token count of content
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_knowledge_documents_updated_at
  BEFORE UPDATE ON active.knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION active.set_updated_at();

-- Product catalog (for use in conversations, proposals, campaigns)
CREATE TABLE active.products_catalog (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES active.organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sku         text,
  description text,
  price       numeric(12,2),
  currency    text NOT NULL DEFAULT 'BRL',
  images      text[] NOT NULL DEFAULT '{}',
  category    text,
  attributes  jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- e.g. { "color": "blue", "size": "M", "weight": "500g" }
  is_active   boolean NOT NULL DEFAULT true,
  -- Link to e-Click SaaS product (if applicable)
  saas_product_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_products_catalog_updated_at
  BEFORE UPDATE ON active.products_catalog
  FOR EACH ROW EXECUTE FUNCTION active.set_updated_at();

-- Response templates with performance tracking
CREATE TABLE active.response_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES active.organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  content         text NOT NULL,
  category        text,  -- greeting, objection, closing, follow_up, pricing, etc.
  context_tags    text[] NOT NULL DEFAULT '{}',
  -- Performance metrics
  use_count       int NOT NULL DEFAULT 0,
  conversion_rate numeric(5,2),  -- Percentage
  avg_response_quality numeric(3,1),  -- AI-rated 1-5
  -- Origin
  ai_generated    boolean NOT NULL DEFAULT false,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_response_templates_updated_at
  BEFORE UPDATE ON active.response_templates
  FOR EACH ROW EXECUTE FUNCTION active.set_updated_at();

-- ============================================================
-- 9. AI & ANALYTICS
-- ============================================================

-- AI interaction log (cost tracking, auditing)
CREATE TABLE active.ai_interactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  interaction_type  text NOT NULL,
  -- Types: classify_intent, suggest_response, summarize, sentiment,
  -- lead_score, copilot, audit, diagnose, train, auto_respond, generate_automation
  model             text NOT NULL,
  provider          text NOT NULL DEFAULT 'anthropic',
  input_tokens      int NOT NULL DEFAULT 0,
  output_tokens     int NOT NULL DEFAULT 0,
  cost_usd          numeric(10,6) NOT NULL DEFAULT 0,
  latency_ms        int,
  -- Context
  conversation_id   uuid,
  contact_id        uuid,
  deal_id           uuid,
  user_id           uuid,  -- Who triggered (null = system)
  -- Result
  result_summary    text,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

-- Create partitions for AI interactions (same pattern as messages)
DO $$
DECLARE
  start_date date := '2026-05-01';
  partition_date date;
  partition_name text;
  next_date date;
BEGIN
  FOR i IN 0..11 LOOP
    partition_date := start_date + (i || ' months')::interval;
    next_date := partition_date + '1 month'::interval;
    partition_name := 'ai_interactions_' || to_char(partition_date, 'YYYY_MM');
    
    EXECUTE format(
      'CREATE TABLE active.%I PARTITION OF active.ai_interactions
       FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      partition_date,
      next_date
    );
  END LOOP;
END $$;

CREATE TABLE active.ai_interactions_default
  PARTITION OF active.ai_interactions DEFAULT;

-- AI feature settings per organization
CREATE TABLE active.ai_feature_settings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES active.organizations(id) ON DELETE CASCADE,
  feature_name  text NOT NULL,
  -- Features: auto_classify, suggest_response, auto_respond, summarize,
  -- lead_scoring, copilot, audit, follow_up_agent, train_agent
  provider      text NOT NULL DEFAULT 'anthropic',
  model         text NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
  enabled       boolean NOT NULL DEFAULT true,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- e.g. { "auto_respond_channels": ["whatsapp"], "confidence_threshold": 0.85 }
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id, feature_name)
);

CREATE TRIGGER trg_ai_feature_settings_updated_at
  BEFORE UPDATE ON active.ai_feature_settings
  FOR EACH ROW EXECUTE FUNCTION active.set_updated_at();

-- Lead scores (dynamic, recalculated periodically)
CREATE TABLE active.lead_scores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  contact_id    uuid NOT NULL REFERENCES active.contacts(id) ON DELETE CASCADE,
  score         int NOT NULL CHECK (score >= 0 AND score <= 100),
  factors       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- e.g. { "engagement": 30, "recency": 25, "fit": 20, "intent": 25, "details": [...] }
  previous_score int,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id, contact_id)
);

-- Funnel analytics snapshots (daily aggregation)
CREATE TABLE active.funnel_analytics (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  pipeline_id     uuid NOT NULL,
  stage_id        uuid NOT NULL,
  snapshot_date   date NOT NULL,
  deals_count     int NOT NULL DEFAULT 0,
  total_value     numeric(14,2) NOT NULL DEFAULT 0,
  avg_time_in_stage_hours numeric(10,1),
  conversion_rate numeric(5,2),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id, pipeline_id, stage_id, snapshot_date)
);

-- Agent performance metrics (daily aggregation)
CREATE TABLE active.agent_performance (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL,
  user_id               uuid NOT NULL,
  period_date           date NOT NULL,
  -- Response metrics
  avg_first_response_ms bigint,
  avg_response_time_ms  bigint,
  -- Volume metrics
  conversations_handled int NOT NULL DEFAULT 0,
  messages_sent         int NOT NULL DEFAULT 0,
  -- Deal metrics
  deals_created         int NOT NULL DEFAULT 0,
  deals_won             int NOT NULL DEFAULT 0,
  deals_lost            int NOT NULL DEFAULT 0,
  revenue               numeric(14,2) NOT NULL DEFAULT 0,
  -- AI feedback
  ai_feedback           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- e.g. { "strengths": [...], "improvements": [...], "score": 78 }
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id, user_id, period_date)
);

-- ============================================================
-- 10. NOTIFICATIONS
-- ============================================================

CREATE TABLE active.notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  user_id     uuid NOT NULL,
  title       text NOT NULL,
  body        text,
  type        text NOT NULL,
  -- Types: new_message, deal_update, task_due, task_overdue, ai_insight,
  -- automation_executed, mention, assignment, system
  severity    text NOT NULL DEFAULT 'info'
              CHECK (severity IN ('info', 'warning', 'urgent', 'success')),
  -- Reference
  entity_type text,  -- conversation, deal, task, contact
  entity_id   uuid,
  -- Status
  read_at     timestamptz,
  action_url  text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- INDEXES
-- ============================================================

-- Identity
CREATE INDEX idx_org_members_user ON active.org_members(user_id);
CREATE INDEX idx_org_members_org ON active.org_members(org_id);

-- Contacts
CREATE INDEX idx_contacts_org ON active.contacts(org_id);
CREATE INDEX idx_contacts_phone ON active.contacts(org_id, phone);
CREATE INDEX idx_contacts_email ON active.contacts(org_id, email);
CREATE INDEX idx_contacts_company ON active.contacts(company_id);
CREATE INDEX idx_contacts_temperature ON active.contacts(org_id, temperature);
CREATE INDEX idx_contacts_score ON active.contacts(org_id, score DESC);
CREATE INDEX idx_contacts_search ON active.contacts USING gin (
  to_tsvector('portuguese', coalesce(name, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(email, ''))
);

-- Companies
CREATE INDEX idx_companies_org ON active.companies(org_id);

-- Channels
CREATE INDEX idx_channels_org ON active.channels(org_id);
CREATE INDEX idx_channels_type ON active.channels(org_id, channel_type);

-- Conversations
CREATE INDEX idx_conversations_org ON active.conversations(org_id);
CREATE INDEX idx_conversations_contact ON active.conversations(contact_id);
CREATE INDEX idx_conversations_assigned ON active.conversations(org_id, assigned_to);
CREATE INDEX idx_conversations_status ON active.conversations(org_id, status);
CREATE INDEX idx_conversations_last_msg ON active.conversations(org_id, last_message_at DESC);
CREATE INDEX idx_conversations_channel ON active.conversations(channel_id);

-- Messages (on each partition, Postgres propagates)
CREATE INDEX idx_messages_conversation ON active.messages(conversation_id, created_at DESC);
CREATE INDEX idx_messages_org ON active.messages(org_id, created_at DESC);
CREATE INDEX idx_messages_channel_ref ON active.messages(channel_message_id);
CREATE INDEX idx_messages_search ON active.messages USING gin (
  to_tsvector('portuguese', coalesce(plain_text, ''))
);

-- Pipelines & Deals
CREATE INDEX idx_pipelines_org ON active.pipelines(org_id);
CREATE INDEX idx_pipeline_stages_pipeline ON active.pipeline_stages(pipeline_id, position);
CREATE INDEX idx_deals_org ON active.deals(org_id);
CREATE INDEX idx_deals_pipeline ON active.deals(pipeline_id, stage_id);
CREATE INDEX idx_deals_contact ON active.deals(contact_id);
CREATE INDEX idx_deals_assigned ON active.deals(org_id, assigned_to);
CREATE INDEX idx_deals_score ON active.deals(org_id, ai_score DESC);
CREATE INDEX idx_deals_stage_position ON active.deals(stage_id, position);

-- Tasks
CREATE INDEX idx_tasks_org ON active.tasks(org_id);
CREATE INDEX idx_tasks_assigned ON active.tasks(org_id, assigned_to, status);
CREATE INDEX idx_tasks_due ON active.tasks(org_id, due_date) WHERE status IN ('pending', 'in_progress');
CREATE INDEX idx_tasks_deal ON active.tasks(deal_id);
CREATE INDEX idx_tasks_contact ON active.tasks(contact_id);

-- Automations
CREATE INDEX idx_automations_org ON active.automations(org_id);
CREATE INDEX idx_automations_trigger ON active.automations(org_id, trigger_type) WHERE is_active = true;
CREATE INDEX idx_automation_logs_automation ON active.automation_logs(automation_id, created_at DESC);

-- Knowledge Base
CREATE INDEX idx_knowledge_docs_org ON active.knowledge_documents(org_id);
CREATE INDEX idx_knowledge_docs_category ON active.knowledge_documents(org_id, category) WHERE is_active = true;
CREATE INDEX idx_knowledge_docs_embedding ON active.knowledge_documents
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_knowledge_docs_search ON active.knowledge_documents USING gin (
  to_tsvector('portuguese', coalesce(title, '') || ' ' || coalesce(content, ''))
);

-- Products
CREATE INDEX idx_products_org ON active.products_catalog(org_id);
CREATE INDEX idx_products_sku ON active.products_catalog(org_id, sku);
CREATE INDEX idx_products_category ON active.products_catalog(org_id, category) WHERE is_active = true;

-- Response Templates
CREATE INDEX idx_response_templates_org ON active.response_templates(org_id);

-- AI
CREATE INDEX idx_ai_interactions_org ON active.ai_interactions(org_id, created_at DESC);
CREATE INDEX idx_ai_interactions_type ON active.ai_interactions(org_id, interaction_type, created_at DESC);
CREATE INDEX idx_lead_scores_contact ON active.lead_scores(contact_id);
CREATE INDEX idx_funnel_analytics_lookup ON active.funnel_analytics(org_id, pipeline_id, snapshot_date DESC);
CREATE INDEX idx_agent_performance_lookup ON active.agent_performance(org_id, user_id, period_date DESC);

-- Notifications
CREATE INDEX idx_notifications_user ON active.notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON active.notifications(user_id, created_at DESC) WHERE read_at IS NULL;

-- Timeline
CREATE INDEX idx_contact_timeline_contact ON active.contact_timeline(contact_id, created_at DESC);
CREATE INDEX idx_deal_activities_deal ON active.deal_activities(deal_id, created_at DESC);

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================

-- Enable RLS on all tables
ALTER TABLE active.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.org_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.contact_timeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.channel_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.deal_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.automation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.products_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.response_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.ai_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.ai_feature_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.lead_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.funnel_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.agent_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE active.notifications ENABLE ROW LEVEL SECURITY;

-- ── RLS Policies ──
-- Pattern: user can access rows where org_id matches their organization

-- Organizations: members can see their own org
CREATE POLICY org_select ON active.organizations
  FOR SELECT USING (id = active.get_user_org_id());
CREATE POLICY org_update ON active.organizations
  FOR UPDATE USING (id = active.get_user_org_id());

-- Org Members: see members of your org
CREATE POLICY members_select ON active.org_members
  FOR SELECT USING (org_id = active.get_user_org_id());
CREATE POLICY members_insert ON active.org_members
  FOR INSERT WITH CHECK (org_id = active.get_user_org_id());
CREATE POLICY members_update ON active.org_members
  FOR UPDATE USING (org_id = active.get_user_org_id());
CREATE POLICY members_delete ON active.org_members
  FOR DELETE USING (org_id = active.get_user_org_id());

-- Macro: generate standard CRUD policies for org_id-based tables
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'workspaces', 'api_keys', 'companies', 'contacts', 'contact_timeline',
    'channels', 'channel_webhooks', 'conversations', 'messages',
    'message_templates', 'pipelines', 'deals', 'deal_activities',
    'tasks', 'automations', 'automation_logs',
    'knowledge_documents', 'products_catalog', 'response_templates',
    'ai_interactions', 'ai_feature_settings', 'lead_scores',
    'funnel_analytics', 'agent_performance'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- SELECT
    EXECUTE format(
      'CREATE POLICY %I ON active.%I FOR SELECT USING (org_id = active.get_user_org_id())',
      tbl || '_select', tbl
    );
    -- INSERT
    EXECUTE format(
      'CREATE POLICY %I ON active.%I FOR INSERT WITH CHECK (org_id = active.get_user_org_id())',
      tbl || '_insert', tbl
    );
    -- UPDATE
    EXECUTE format(
      'CREATE POLICY %I ON active.%I FOR UPDATE USING (org_id = active.get_user_org_id())',
      tbl || '_update', tbl
    );
    -- DELETE
    EXECUTE format(
      'CREATE POLICY %I ON active.%I FOR DELETE USING (org_id = active.get_user_org_id())',
      tbl || '_delete', tbl
    );
  END LOOP;
END $$;

-- Notifications: user can only see their own
CREATE POLICY notifications_select ON active.notifications
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY notifications_update ON active.notifications
  FOR UPDATE USING (user_id = auth.uid());

-- ============================================================
-- TRIGGERS: Conversation counters & timeline
-- ============================================================

-- Update conversation counters on new message
CREATE OR REPLACE FUNCTION active.on_message_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE active.conversations
  SET
    message_count = message_count + 1,
    last_message_at = NEW.created_at,
    unread_count = CASE
      WHEN NEW.direction = 'inbound' THEN unread_count + 1
      ELSE unread_count
    END,
    -- Set first response time for agents
    first_response_at = CASE
      WHEN first_response_at IS NULL
        AND NEW.direction = 'outbound'
        AND NEW.sender_type = 'agent'
      THEN NEW.created_at
      ELSE first_response_at
    END,
    updated_at = now()
  WHERE id = NEW.conversation_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_message_insert
  AFTER INSERT ON active.messages
  FOR EACH ROW EXECUTE FUNCTION active.on_message_insert();

-- Update deal stage_entered_at when stage changes
CREATE OR REPLACE FUNCTION active.on_deal_stage_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.stage_id IS DISTINCT FROM NEW.stage_id THEN
    NEW.stage_entered_at = now();
    
    -- Log the stage change
    INSERT INTO active.deal_activities (org_id, deal_id, activity_type, title, metadata, created_by)
    VALUES (
      NEW.org_id,
      NEW.id,
      'stage_changed',
      'Etapa alterada',
      jsonb_build_object(
        'from_stage_id', OLD.stage_id,
        'to_stage_id', NEW.stage_id
      ),
      NEW.assigned_to
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_deal_stage_change
  BEFORE UPDATE ON active.deals
  FOR EACH ROW EXECUTE FUNCTION active.on_deal_stage_change();

-- Mark overdue tasks
CREATE OR REPLACE FUNCTION active.mark_overdue_tasks()
RETURNS void
LANGUAGE sql
AS $$
  UPDATE active.tasks
  SET status = 'overdue', updated_at = now()
  WHERE status IN ('pending', 'in_progress')
    AND due_date < now();
$$;

-- Schedule overdue check every 15 minutes
SELECT cron.schedule(
  'active-mark-overdue-tasks',
  '*/15 * * * *',
  'SELECT active.mark_overdue_tasks()'
);

-- ============================================================
-- VIEWS
-- ============================================================

-- Conversation inbox view (optimized for the inbox UI)
CREATE OR REPLACE VIEW active.v_inbox AS
SELECT
  c.id,
  c.org_id,
  c.status,
  c.priority,
  c.assigned_to,
  c.unread_count,
  c.ai_summary,
  c.ai_sentiment,
  c.ai_intent,
  c.ai_temperature,
  c.ai_next_action,
  c.tags,
  c.last_message_at,
  c.first_response_at,
  c.created_at,
  c.channel_type,
  -- Contact info
  ct.id AS contact_id,
  ct.name AS contact_name,
  ct.phone AS contact_phone,
  ct.email AS contact_email,
  ct.avatar_url AS contact_avatar,
  ct.temperature AS contact_temperature,
  ct.score AS contact_score,
  -- Channel info
  ch.name AS channel_name,
  -- Assigned agent info
  om.display_name AS agent_name,
  om.avatar_url AS agent_avatar
FROM active.conversations c
LEFT JOIN active.contacts ct ON ct.id = c.contact_id
LEFT JOIN active.channels ch ON ch.id = c.channel_id
LEFT JOIN active.org_members om ON om.user_id = c.assigned_to AND om.org_id = c.org_id;

-- Deal board view (optimized for the Kanban UI)
CREATE OR REPLACE VIEW active.v_deal_board AS
SELECT
  d.id,
  d.org_id,
  d.pipeline_id,
  d.stage_id,
  d.title,
  d.value,
  d.currency,
  d.expected_close_date,
  d.ai_score,
  d.ai_risk,
  d.ai_next_action,
  d.ai_close_probability,
  d.tags,
  d.position,
  d.stage_entered_at,
  d.created_at,
  -- Contact
  ct.id AS contact_id,
  ct.name AS contact_name,
  ct.phone AS contact_phone,
  ct.avatar_url AS contact_avatar,
  ct.temperature AS contact_temperature,
  -- Company
  co.id AS company_id,
  co.name AS company_name,
  -- Stage
  ps.name AS stage_name,
  ps.color AS stage_color,
  ps.position AS stage_position,
  ps.probability AS stage_probability,
  ps.sla_hours,
  -- Assignment
  om.display_name AS agent_name,
  om.avatar_url AS agent_avatar,
  -- Time in stage
  EXTRACT(EPOCH FROM (now() - d.stage_entered_at)) / 3600 AS hours_in_stage,
  -- SLA breach flag
  CASE
    WHEN ps.sla_hours IS NOT NULL
      AND EXTRACT(EPOCH FROM (now() - d.stage_entered_at)) / 3600 > ps.sla_hours
    THEN true
    ELSE false
  END AS sla_breached
FROM active.deals d
LEFT JOIN active.contacts ct ON ct.id = d.contact_id
LEFT JOIN active.companies co ON co.id = d.company_id
LEFT JOIN active.pipeline_stages ps ON ps.id = d.stage_id
LEFT JOIN active.org_members om ON om.user_id = d.assigned_to AND om.org_id = d.org_id
WHERE d.won_at IS NULL AND d.lost_at IS NULL;

-- ============================================================
-- SEED: Default data for new organizations
-- ============================================================

-- Function to bootstrap a new organization with defaults
CREATE OR REPLACE FUNCTION active.setup_new_organization(
  p_org_id uuid,
  p_user_id uuid,
  p_org_name text,
  p_user_display_name text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pipeline_id uuid;
  v_stages text[] := ARRAY[
    'Novo Lead',
    'Contato Realizado',
    'Qualificado',
    'Proposta Enviada',
    'Negociação',
    'Fechamento'
  ];
  v_colors text[] := ARRAY[
    '#00E5FF', '#0EA5E9', '#8B5CF6', '#F59E0B', '#EF4444', '#22C55E'
  ];
  v_probabilities int[] := ARRAY[10, 20, 40, 60, 80, 95];
  v_stage_name text;
  v_idx int;
BEGIN
  -- Add owner as org member
  INSERT INTO active.org_members (org_id, user_id, role, display_name, status)
  VALUES (p_org_id, p_user_id, 'owner', p_user_display_name, 'active');

  -- Create default pipeline
  INSERT INTO active.pipelines (id, org_id, name, is_default)
  VALUES (gen_random_uuid(), p_org_id, 'Funil Principal', true)
  RETURNING id INTO v_pipeline_id;

  -- Create default stages
  v_idx := 0;
  FOREACH v_stage_name IN ARRAY v_stages LOOP
    INSERT INTO active.pipeline_stages (pipeline_id, name, position, color, probability)
    VALUES (v_pipeline_id, v_stage_name, v_idx, v_colors[v_idx + 1], v_probabilities[v_idx + 1]);
    v_idx := v_idx + 1;
  END LOOP;

  -- Add Won and Lost stages
  INSERT INTO active.pipeline_stages (pipeline_id, name, position, color, probability, is_won)
  VALUES (v_pipeline_id, 'Ganho', v_idx, '#22C55E', 100, true);
  v_idx := v_idx + 1;

  INSERT INTO active.pipeline_stages (pipeline_id, name, position, color, probability, is_lost)
  VALUES (v_pipeline_id, 'Perdido', v_idx, '#6B7280', 0, true);

  -- Create default AI feature settings
  INSERT INTO active.ai_feature_settings (org_id, feature_name, provider, model, enabled) VALUES
    (p_org_id, 'auto_classify', 'anthropic', 'claude-haiku-4-5-20251001', true),
    (p_org_id, 'suggest_response', 'anthropic', 'claude-haiku-4-5-20251001', true),
    (p_org_id, 'summarize', 'anthropic', 'claude-haiku-4-5-20251001', true),
    (p_org_id, 'sentiment', 'anthropic', 'claude-haiku-4-5-20251001', true),
    (p_org_id, 'lead_scoring', 'anthropic', 'claude-sonnet-4-6', true),
    (p_org_id, 'copilot', 'anthropic', 'claude-sonnet-4-6', false),
    (p_org_id, 'auto_respond', 'anthropic', 'claude-sonnet-4-6', false),
    (p_org_id, 'follow_up_agent', 'anthropic', 'claude-haiku-4-5-20251001', false);

END;
$$;

-- ============================================================
-- COMMENTS
-- ============================================================
COMMENT ON SCHEMA active IS 'e-Click Active CRM - Inteligência Comercial Ativa';
COMMENT ON TABLE active.organizations IS 'Empresa-cliente do CRM (unidade de cobrança e isolamento)';
COMMENT ON TABLE active.contacts IS 'Lead/cliente - pessoa física com quem a empresa conversa';
COMMENT ON TABLE active.conversations IS 'Thread de conversa omnichannel com um contato';
COMMENT ON TABLE active.messages IS 'Mensagens individuais (particionada por mês para performance)';
COMMENT ON TABLE active.deals IS 'Negócio/oportunidade no funil de vendas';
COMMENT ON TABLE active.knowledge_documents IS 'Base de conhecimento da empresa para treinar a IA';
COMMENT ON TABLE active.ai_interactions IS 'Log de todas as chamadas de IA (custo, latência, audit)';
COMMENT ON FUNCTION active.setup_new_organization IS 'Bootstrap completo de uma nova organização com funil, estágios e configurações de IA padrão';
