-- AI Visibility OS — nutrição da Auditoria GEO pública (Sprint 2c).
-- Drip de email + WhatsApp orquestrado no SaaS (Active não tem motor de email),
-- refletido no funil "Captação GEO" do Active. Agenda + idempotência via UNIQUE.

CREATE TABLE IF NOT EXISTS public.public_audit_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id      uuid NOT NULL REFERENCES public.public_audits(id) ON DELETE CASCADE,
  step          varchar(8)  NOT NULL,                 -- d0, d2, d5, d8, d10
  channel       varchar(10) NOT NULL,                 -- email | whatsapp
  scheduled_at  timestamptz NOT NULL,
  status        varchar(12) NOT NULL DEFAULT 'pending', -- pending|sent|failed|skipped
  sent_at       timestamptz,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (audit_id, step, channel)
);
CREATE INDEX IF NOT EXISTS idx_pam_due
  ON public.public_audit_messages (scheduled_at) WHERE status = 'pending';

ALTER TABLE public.public_audit_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pam_service_role ON public.public_audit_messages;
CREATE POLICY pam_service_role ON public.public_audit_messages
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
GRANT ALL ON TABLE public.public_audit_messages TO service_role;

-- ============================================================
-- ROLLBACK:
-- DROP TABLE IF EXISTS public.public_audit_messages;
-- ============================================================
