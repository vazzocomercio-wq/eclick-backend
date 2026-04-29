-- Sprint F5-1 — módulo de Campanhas (entidade dedicada com persistência,
-- agendamento, A/B test, anti-detecção via interval+jitter, e métricas).
--
-- Substitui o disparo ad-hoc de POST /messaging/campaigns/send (que só
-- gravava em messaging_sends sem persistir a "campanha" como entidade).
-- A nova UI vive em /dashboard/campanhas (separada de /messaging).
--
-- Rollback:
--   DROP FUNCTION IF EXISTS increment_campaign_counter(uuid,text,integer);
--   DROP TABLE IF EXISTS campaign_targets;
--   DROP TABLE IF EXISTS campaigns;

BEGIN;

-- ── 1. campaigns — entidade principal ───────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','scheduled','running','paused','completed','cancelled')),
  channel          text NOT NULL DEFAULT 'whatsapp'
                   CHECK (channel IN ('whatsapp','email','both')),

  -- Audiência
  segment_type     text NOT NULL DEFAULT 'all'
                   CHECK (segment_type IN ('all','vip','with_cpf','custom')),
  segment_filters  jsonb,
  estimated_reach  integer,

  -- Cadência / anti-detecção
  scheduled_at     timestamptz,
  interval_seconds integer NOT NULL DEFAULT 60,
  interval_jitter  integer NOT NULL DEFAULT 30,
  daily_limit      integer NOT NULL DEFAULT 200,

  -- A/B test
  ab_enabled       boolean NOT NULL DEFAULT false,
  ab_split_pct     integer DEFAULT 50,

  -- Conteúdo
  product_ids      uuid[],
  template_a_id    uuid REFERENCES messaging_templates(id),
  template_b_id    uuid REFERENCES messaging_templates(id),

  -- Métricas live (atualizadas pelo cron processCampaignTargets)
  total_targets    integer DEFAULT 0,
  total_sent       integer DEFAULT 0,
  total_delivered  integer DEFAULT 0,
  total_failed     integer DEFAULT 0,
  started_at       timestamptz,
  completed_at     timestamptz,

  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ── 2. campaign_targets — fila de envio individual por customer ────────
CREATE TABLE IF NOT EXISTS campaign_targets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  organization_id  uuid NOT NULL,
  customer_id      uuid NOT NULL REFERENCES unified_customers(id),
  variant          text NOT NULL DEFAULT 'a' CHECK (variant IN ('a','b')),
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','sent','delivered','failed','skipped')),
  scheduled_for    timestamptz,
  sent_at          timestamptz,
  error_message    text,
  messaging_send_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ── 3. Indexes ──────────────────────────────────────────────────────────
-- Lookup do cron processCampaignTargets:
--   WHERE status='pending' AND scheduled_for <= now() ORDER BY scheduled_for
CREATE INDEX IF NOT EXISTS campaign_targets_campaign_status_idx
  ON campaign_targets (campaign_id, status, scheduled_for);

CREATE INDEX IF NOT EXISTS campaign_targets_scheduled_idx
  ON campaign_targets (scheduled_for, status)
  WHERE status = 'pending';

-- ── 4. RLS ──────────────────────────────────────────────────────────────
ALTER TABLE campaigns        ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_targets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members campaigns" ON campaigns;
CREATE POLICY "org members campaigns" ON campaigns FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "org members campaign_targets" ON campaign_targets;
CREATE POLICY "org members campaign_targets" ON campaign_targets FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

GRANT ALL ON campaigns        TO service_role;
GRANT ALL ON campaign_targets TO service_role;

-- ── 5. RPC pra increment atômico de contadores ────────────────────────
-- Usado por campaigns.service.ts processCampaignTargets pra bumpar
-- total_sent/total_delivered/total_failed de forma atômica (vs SELECT+UPDATE
-- que tem race entre tick processando o mesmo target). O fallback no service
-- (bumpCounterFallback) só roda se essa RPC não existir no banco.
CREATE OR REPLACE FUNCTION increment_campaign_counter(
  p_campaign_id uuid,
  p_field text,
  p_delta integer DEFAULT 1
) RETURNS void AS $$
BEGIN
  IF p_field NOT IN ('total_sent','total_delivered','total_failed') THEN
    RAISE EXCEPTION 'Invalid field: %', p_field;
  END IF;
  EXECUTE format(
    'UPDATE campaigns SET %I = COALESCE(%I,0) + $1, updated_at = now() WHERE id = $2',
    p_field, p_field
  ) USING p_delta, p_campaign_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION increment_campaign_counter TO service_role;

COMMIT;
