-- Sprint EM-1 — email provider multi-tenant (per-org config)
--
-- Substitui a abordagem env-based (RESEND_API_KEY no Railway, single-tenant)
-- por config por organização armazenada criptografada (AES-256-CBC com IV
-- aleatório, key derivada da env ENCRYPTION_KEY do backend). Permite que
-- cada org escolha entre Resend ou SendGrid e use sua própria conta.
--
-- Também adiciona coluna `subject` em messaging_templates (consolida a
-- migration anterior 2026_04_29_email_subject.sql que foi descartada).
--
-- Rollback:
--   DROP TABLE IF EXISTS email_settings;
--   ALTER TABLE messaging_templates DROP COLUMN IF EXISTS subject;

BEGIN;

-- ── 1. Tabela email_settings (1 row por org) ─────────────────────────────
CREATE TABLE IF NOT EXISTS email_settings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid UNIQUE NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('resend','sendgrid')),
  api_key_enc      text NOT NULL,
  from_name        text NOT NULL,
  from_address     text NOT NULL,
  is_verified      boolean NOT NULL DEFAULT false,
  last_tested_at   timestamptz,
  last_test_error  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ── 2. RLS — só membros da org acessam ───────────────────────────────────
ALTER TABLE email_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members can manage email_settings" ON email_settings;
CREATE POLICY "org members can manage email_settings"
  ON email_settings FOR ALL
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid()
    )
  );

-- service_role bypassa RLS por padrão; GRANT explícito pra clareza.
GRANT ALL ON email_settings TO service_role;

-- ── 3. messaging_templates.subject (consolida migration anterior) ────────
ALTER TABLE messaging_templates
  ADD COLUMN IF NOT EXISTS subject text;

COMMENT ON COLUMN messaging_templates.subject IS
  'Assunto do email. Se NULL, usa o name do template como fallback.';

COMMIT;
