-- M1 — Margin Gate + ops controls (Sprint Vazzo 2026-05-08)
-- ════════════════════════════════════════════════════════════════════════
-- 1) ml_campaigns_config: novos campos de operação (assignee, manager,
--    notification_phone, deadline alerts, soft gate threshold,
--    per-type overrides, audit threshold)
-- 2) ml_campaign_recommendations: novos status pending_manager_approval /
--    manager_approved / rejected_by_manager + colunas de decisão do gestor
-- 3) ml_campaign_approval_attempts: log de tentativas de aprovar
--    abaixo do gate (mesmo se gestor rejeitar depois). Sinal pro gestor
--    detectar processo quebrado.

-- ─── 1. Config: operação humana ─────────────────────────────────
ALTER TABLE ml_campaigns_config
  -- Operador responsável (recebe alertas; default por seller)
  ADD COLUMN IF NOT EXISTS assignee_user_id          uuid,
  ADD COLUMN IF NOT EXISTS notification_phone        text,
  -- Manager (pode aprovar override + recebe alerta de tentativas suspeitas)
  ADD COLUMN IF NOT EXISTS manager_user_id           uuid,
  ADD COLUMN IF NOT EXISTS manager_whatsapp_phone    text,
  -- Soft gate: margem mínima pra aprovar sem manager
  ADD COLUMN IF NOT EXISTS min_approval_margin_pct   numeric NOT NULL DEFAULT 10,
  -- Override por tipo de campanha (ex: { "DEAL": 8, "PRICE_DISCOUNT": 15 })
  ADD COLUMN IF NOT EXISTS per_campaign_type_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Deadline alerts
  ADD COLUMN IF NOT EXISTS deadline_alert_days_before integer NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS whatsapp_alerts_enabled    boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS escalate_alerts            boolean NOT NULL DEFAULT true,
  -- Alerta proativo de oportunidade (subsídio alto)
  ADD COLUMN IF NOT EXISTS auto_alert_when_subsidy_above_pct numeric NOT NULL DEFAULT 15,
  -- Audit: threshold de tentativas abaixo do gate em 30d
  ADD COLUMN IF NOT EXISTS audit_attempts_threshold   integer NOT NULL DEFAULT 5;

-- ─── 2. Recommendations: novos status do soft gate ──────────────
-- Drop+re-add do CHECK pra adicionar novos valores
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname = 'ml_campaign_recommendations_status_check') THEN
    ALTER TABLE ml_campaign_recommendations
      DROP CONSTRAINT ml_campaign_recommendations_status_check;
  END IF;
END $$;

ALTER TABLE ml_campaign_recommendations
  ADD CONSTRAINT ml_campaign_recommendations_status_check CHECK (status IN (
    'pending',                    -- aguardando revisão do operador
    'approved',                   -- aprovado pelo operador (margem OK)
    'edited',                     -- operador editou + aprovou
    'pending_manager_approval',   -- operador tentou aprovar, mas margem < gate → fila do gestor
    'manager_approved',           -- gestor liberou override
    'rejected_by_manager',        -- gestor rejeitou override
    'rejected',                   -- operador rejeitou
    'auto_approved',              -- v2: auto-approve regra
    'applied',                    -- aplicado em ML
    'expired'                     -- deadline da campanha passou
  ));

-- Colunas pra decisão do gestor
ALTER TABLE ml_campaign_recommendations
  ADD COLUMN IF NOT EXISTS manager_decided_by      uuid,
  ADD COLUMN IF NOT EXISTS manager_decided_at      timestamptz,
  ADD COLUMN IF NOT EXISTS manager_decision_reason text,
  -- Snapshot da margem na hora da tentativa (não muda se config mudar depois)
  ADD COLUMN IF NOT EXISTS attempted_margin_pct    numeric,
  ADD COLUMN IF NOT EXISTS gate_threshold_pct      numeric;

-- Index pra fila do gestor
CREATE INDEX IF NOT EXISTS idx_recos_pending_manager
  ON ml_campaign_recommendations(organization_id, seller_id, status)
  WHERE status = 'pending_manager_approval';

-- ─── 3. Audit log de tentativas de aprovar abaixo do gate ──────
CREATE TABLE IF NOT EXISTS ml_campaign_approval_attempts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id                bigint NOT NULL,
  recommendation_id        uuid NOT NULL REFERENCES ml_campaign_recommendations(id) ON DELETE CASCADE,
  operator_user_id         uuid NOT NULL,
  attempted_margin_pct     numeric NOT NULL,
  threshold_pct            numeric NOT NULL,
  campaign_type            text,
  outcome                  text NOT NULL CHECK (outcome IN (
    'sent_to_manager',     -- entrou na fila pendente
    'manager_approved',    -- gestor liberou
    'manager_rejected',    -- gestor rejeitou
    'auto_approved',       -- margem OK, passou direto (não logamos esses, só pra completude do enum)
    'self_corrected'       -- operador editou e re-aprovou com margem OK
  )),
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approval_attempts_operator_recent
  ON ml_campaign_approval_attempts(organization_id, operator_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_attempts_reco
  ON ml_campaign_approval_attempts(recommendation_id);

GRANT ALL ON TABLE ml_campaign_approval_attempts TO authenticated, service_role;
