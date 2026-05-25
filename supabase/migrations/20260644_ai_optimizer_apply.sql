-- AI Visibility OS — geo-optimizer Dia 12 (infra do piloto controlado).
-- Versionamento (rollback) + snapshot de baseline pra medir impacto (Dia 14).
-- Multi-tenant + GRANT só service_role. NÃO aplica nada no ML — só a infra.

-- Histórico de versões de cada anúncio (apply + rollback).
CREATE TABLE IF NOT EXISTS public.ai_optimizer_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  optimizer_id       uuid REFERENCES public.ai_optimizer_results(id) ON DELETE SET NULL,
  listing_id         text NOT NULL,                 -- ml_item_id (MLB...)
  platform           varchar(30),
  version_number     int NOT NULL DEFAULT 1,
  title_old          text,
  title_new          text,
  description_old    text,
  description_new    text,
  changed_by_user_id uuid,                            -- auth.users.id
  was_rollback       boolean NOT NULL DEFAULT false,
  changed_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aov_org_listing ON public.ai_optimizer_versions (org_id, listing_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_aov_apply_day   ON public.ai_optimizer_versions (org_id, changed_at) WHERE was_rollback = false;

-- Snapshot de métricas ANTES do apply (base do ImpactTracker).
CREATE TABLE IF NOT EXISTS public.ai_optimizer_baselines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  optimizer_id  uuid REFERENCES public.ai_optimizer_results(id) ON DELETE SET NULL,
  version_id    uuid REFERENCES public.ai_optimizer_versions(id) ON DELETE SET NULL,
  listing_id    text NOT NULL,
  snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {geo_score, visits_14d, units_14d, revenue_14d, review_count, ads_metrics}
  captured_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aob_org_listing ON public.ai_optimizer_baselines (org_id, listing_id, captured_at DESC);

ALTER TABLE public.ai_optimizer_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_optimizer_baselines ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.ai_optimizer_versions  TO service_role;
GRANT ALL ON TABLE public.ai_optimizer_baselines TO service_role;

-- ============================================================
-- ROLLBACK:
-- DROP TABLE IF EXISTS public.ai_optimizer_baselines;
-- DROP TABLE IF EXISTS public.ai_optimizer_versions;
-- ============================================================
