-- ═══════════════════════════════════════════════════
-- 20260660: Newsletter do blog público (eclick.app.br/blog)
--
-- Captura de inscrições do widget `/blog` + fila de broadcast pro envio
-- quando um post novo é publicado. NÃO multi-tenant — é a newsletter
-- DA e-Click pro blog dela (Sanity); por isso sem organization_id.
--
-- Endpoints (módulo blog-newsletter):
--   POST /public/blog/newsletter/signup           — inscreve (idempotente)
--   GET  /public/blog/newsletter/unsubscribe      — opt-out via token
--   POST /internal/blog/notify-subscribers        — gatilho (Active → SaaS)
-- ═══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.blog_newsletter_signups (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL,
  email_lower         text GENERATED ALWAYS AS (lower(email)) STORED,
  status              text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','unsubscribed','bounced')),
  unsubscribe_token   text NOT NULL DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  source_post_slug    text,
  source_position     text,                                  -- ex: 'footer-top', 'inline-middle'
  utm_source          text,
  utm_medium          text,
  utm_campaign        text,
  ip_hash             text,                                  -- SHA-256 do IP+salt (anti-spam, sem PII)
  user_agent          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  unsubscribed_at     timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS blog_newsletter_email_uidx
  ON public.blog_newsletter_signups(email_lower);
CREATE UNIQUE INDEX IF NOT EXISTS blog_newsletter_token_uidx
  ON public.blog_newsletter_signups(unsubscribe_token);
CREATE INDEX IF NOT EXISTS blog_newsletter_status_idx
  ON public.blog_newsletter_signups(status, created_at DESC);

-- Fila de envios — cada broadcast cria 1 row por subscriber ativo.
-- Worker (cron) pega `status='pending'` e dispara via EmailSenderService.
CREATE TABLE IF NOT EXISTS public.blog_newsletter_broadcasts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_slug       text NOT NULL,
  post_title      text NOT NULL,
  post_excerpt    text,
  cover_image_url text,
  status          text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sending','sent','failed')),
  total_targets   int NOT NULL DEFAULT 0,
  total_sent      int NOT NULL DEFAULT 0,
  total_failed    int NOT NULL DEFAULT 0,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

CREATE INDEX IF NOT EXISTS blog_newsletter_broadcasts_status_idx
  ON public.blog_newsletter_broadcasts(status, created_at);
-- Idempotência: 1 broadcast por slug.
CREATE UNIQUE INDEX IF NOT EXISTS blog_newsletter_broadcasts_slug_uidx
  ON public.blog_newsletter_broadcasts(post_slug);

CREATE TABLE IF NOT EXISTS public.blog_newsletter_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id    uuid NOT NULL REFERENCES public.blog_newsletter_broadcasts(id) ON DELETE CASCADE,
  signup_id       uuid NOT NULL REFERENCES public.blog_newsletter_signups(id) ON DELETE CASCADE,
  email           text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','failed')),
  provider_message_id text,
  error_message   text,
  attempted_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS blog_newsletter_deliveries_pending_idx
  ON public.blog_newsletter_deliveries(status, created_at)
  WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS blog_newsletter_deliveries_unique_idx
  ON public.blog_newsletter_deliveries(broadcast_id, signup_id);

-- ── RLS ─────────────────────────────────────────────────────────────
-- Não é multi-tenant; só service_role escreve/lê via backend. Negamos
-- tudo de authenticated pra evitar leak (mesmo padrão de tabelas
-- platform-only do roadmap).
ALTER TABLE public.blog_newsletter_signups     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_newsletter_broadcasts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_newsletter_deliveries  ENABLE ROW LEVEL SECURITY;

-- ── Grants (tabelas criadas via _admin_exec_sql não herdam o default) ──
GRANT SELECT, INSERT, UPDATE, DELETE ON public.blog_newsletter_signups     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.blog_newsletter_broadcasts  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.blog_newsletter_deliveries  TO service_role;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.blog_newsletter_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS blog_newsletter_signups_touch ON public.blog_newsletter_signups;
CREATE TRIGGER blog_newsletter_signups_touch
  BEFORE UPDATE ON public.blog_newsletter_signups
  FOR EACH ROW EXECUTE FUNCTION public.blog_newsletter_touch_updated_at();
