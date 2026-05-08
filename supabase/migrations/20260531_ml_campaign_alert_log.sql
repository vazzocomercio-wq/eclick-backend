-- M2 — Log de alertas de campanha (dedup + tracking de envio)
-- Evita mandar mesmo alerta 2x no mesmo dia. Suporta queries
-- "operador X recebeu N alertas hoje" pro M3 (agrupamento).

CREATE TABLE IF NOT EXISTS ml_campaign_alert_log (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id             bigint NOT NULL,
  campaign_id           uuid NOT NULL REFERENCES ml_campaigns(id) ON DELETE CASCADE,
  alert_type            text NOT NULL CHECK (alert_type IN (
    'deadline_warning',         -- D-2/D-1/D-0 escala
    'subsidy_opportunity',      -- proativo, ML banca alto
    'manager_pending_queue',    -- gestor: tem N na fila pra aprovar
    'audit_threshold_exceeded'  -- gestor: operador X tentou N+ aprovacoes abaixo do gate
  )),
  severity              text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  -- Quem foi notificado (snapshot — pode ter mudado depois no config)
  recipient_user_id     uuid,
  recipient_phone       text,
  -- Conteúdo enviado (pra audit/rerun)
  message               text NOT NULL,
  deeplink              text,
  bridge_response       jsonb,
  -- Estado
  status                text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','skipped_dedup','skipped_no_action','failed')),
  skip_reason           text,
  -- Pra dedup: chave lógica que identifica "esse alerta específico"
  -- Ex: "deadline_warning:campaign_id:2026-05-08:high"
  dedup_key             text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Index pra dedup rápido (não enviar 2x no mesmo dia)
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_log_dedup
  ON ml_campaign_alert_log(organization_id, dedup_key)
  WHERE status = 'sent';

-- Index pra "quantos alertas o operador X recebeu hoje" (M3 grouping)
CREATE INDEX IF NOT EXISTS idx_alert_log_recipient_recent
  ON ml_campaign_alert_log(organization_id, recipient_user_id, created_at DESC)
  WHERE status = 'sent';

CREATE INDEX IF NOT EXISTS idx_alert_log_campaign
  ON ml_campaign_alert_log(campaign_id, created_at DESC);

GRANT ALL ON TABLE ml_campaign_alert_log TO authenticated, service_role;
