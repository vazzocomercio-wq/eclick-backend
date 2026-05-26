-- AI Visibility OS — descadastro (LGPD) da Auditoria GEO pública.
-- opted_out trava a nutrição (agendamento + envio) por email.

ALTER TABLE public.public_audits ADD COLUMN IF NOT EXISTS opted_out    boolean NOT NULL DEFAULT false;
ALTER TABLE public.public_audits ADD COLUMN IF NOT EXISTS opted_out_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_public_audits_optout_email
  ON public.public_audits (email) WHERE opted_out = true;

-- ============================================================
-- ROLLBACK:
-- DROP INDEX IF EXISTS public.idx_public_audits_optout_email;
-- ALTER TABLE public.public_audits DROP COLUMN IF EXISTS opted_out_at;
-- ALTER TABLE public.public_audits DROP COLUMN IF EXISTS opted_out;
-- ============================================================
