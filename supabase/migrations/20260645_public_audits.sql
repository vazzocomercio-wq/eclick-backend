-- AI Visibility OS — Landing pública "Auditoria GEO Grátis" (Sprint 1).
-- Captura de lead + execução de um GEO Score em modo público (sem conta).
-- O resultado da análise (worker) é Sprint 2; aqui só a infra de captura.
--
-- Privacidade (LGPD): NÃO guardamos IP cru — só o SHA-256 (ip_hash). Email/nome
-- são dados pessoais → tabela é service_role only (sem GRANT pra authenticated).
-- Tabelas criadas via _admin_exec_sql não herdam default privileges → GRANT explícito.

-- ── Auditorias públicas ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.public_audits (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Lead (nome completo + email + whatsapp obrigatórios; categoria opcional)
  name               varchar(120) NOT NULL,
  email              varchar(160) NOT NULL,
  whatsapp           varchar(24)  NOT NULL,
  category           varchar(60),
  ip_hash            varchar(64)  NOT NULL,      -- SHA-256 do IP (LGPD)
  user_agent         text,
  utm                jsonb,                       -- {source,medium,campaign,content} (Sprint 3)

  -- URL analisada
  url                text NOT NULL,
  url_normalized     text NOT NULL,
  detected_platform  varchar(30),                 -- mercadolivre|shopee|amazon|generic|unknown

  -- Resultado
  status             varchar(20) NOT NULL DEFAULT 'running',  -- running|done|failed
  geo_score          int,
  result_json        jsonb,
  error_message      text,

  -- Bridge Active CRM (funil "Captação GEO")
  active_contact_id  uuid,
  active_deal_id     uuid,
  active_funnel_stage varchar(80),

  -- Auditoria
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  duration_ms        int
);
CREATE INDEX IF NOT EXISTS idx_public_audits_email   ON public.public_audits (email);
CREATE INDEX IF NOT EXISTS idx_public_audits_status  ON public.public_audits (status);
CREATE INDEX IF NOT EXISTS idx_public_audits_created ON public.public_audits (created_at DESC);

-- ── Rate limit por IP (janela de 24h, sem Redis) ─────────────────────
CREATE TABLE IF NOT EXISTS public.public_audit_rate_limits (
  ip_hash      varchar(64) PRIMARY KEY,           -- SHA-256 do IP
  count        int NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ── RLS: service_role only (dados pessoais; API anônima nunca lê direto) ──
ALTER TABLE public.public_audits            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_audit_rate_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS public_audits_service_role ON public.public_audits;
CREATE POLICY public_audits_service_role ON public.public_audits
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS public_audit_rate_limits_service_role ON public.public_audit_rate_limits;
CREATE POLICY public_audit_rate_limits_service_role ON public.public_audit_rate_limits
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

GRANT ALL ON TABLE public.public_audits            TO service_role;
GRANT ALL ON TABLE public.public_audit_rate_limits TO service_role;

-- ============================================================
-- ROLLBACK:
-- DROP TABLE IF EXISTS public.public_audit_rate_limits;
-- DROP TABLE IF EXISTS public.public_audits;
-- ============================================================
