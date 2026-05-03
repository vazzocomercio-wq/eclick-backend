-- Sprint ML Questions AI — tabela de sugestões IA pra perguntas do Mercado Livre.
-- Cron @5min preenche pending; user aprova/edita/rejeita; cron envia auto se
-- toggle auto-send (ai_feature_settings.enabled[ml_question_auto_send]) = true.

CREATE TABLE IF NOT EXISTS ml_question_suggestions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  question_id        text NOT NULL,
  item_id            text NOT NULL,
  question_text      text NOT NULL,
  suggested_answer   text NOT NULL,
  confidence         numeric(4,2),
  status             text DEFAULT 'pending'
    CHECK (status IN ('pending','approved','edited','sent','rejected','auto_sent')),
  final_answer       text,
  context_used       jsonb DEFAULT '{}'::jsonb,
  agent_id           uuid,
  auto_send_eligible boolean DEFAULT false,
  used_as_is         boolean,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now(),
  UNIQUE (organization_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_mlqs_org_status
  ON ml_question_suggestions(organization_id, status);

CREATE INDEX IF NOT EXISTS idx_mlqs_org_created
  ON ml_question_suggestions(organization_id, created_at DESC);
