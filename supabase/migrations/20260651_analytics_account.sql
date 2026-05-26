-- ═══════════════════════════════════════════════════
-- 20260651: Analytics Hub — insights de CONTA (F2)
-- Snapshot diário por conta: seguidores/alcance/visitas/engajamento +
-- demografia da audiência (best-effort; Meta exige ≥100 seguidores).
-- Leitura backend-gated (GRANT só service_role, RLS deny).
-- ═══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.analytics_account_metrics_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  network text NOT NULL,                  -- instagram | facebook | ...
  account_external_id text NOT NULL,      -- ig user id / page id
  date date NOT NULL,

  -- Totais (campos do nó da conta)
  followers_count bigint NOT NULL DEFAULT 0,
  follows_count bigint NOT NULL DEFAULT 0,
  media_count bigint NOT NULL DEFAULT 0,

  -- Insights do dia (metric_type=total_value, period=day)
  reach bigint NOT NULL DEFAULT 0,
  profile_views bigint NOT NULL DEFAULT 0,
  website_clicks bigint NOT NULL DEFAULT 0,
  accounts_engaged bigint NOT NULL DEFAULT 0,

  -- Demografia da audiência (age/gender/country/city) — {} quando indisponível
  demographics jsonb NOT NULL DEFAULT '{}',

  raw_metrics jsonb NOT NULL DEFAULT '{}',
  insights_available boolean NOT NULL DEFAULT false,

  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_id, account_external_id, date)
);

CREATE INDEX IF NOT EXISTS idx_aamd_org_date
  ON public.analytics_account_metrics_daily (organization_id, account_external_id, date DESC);

ALTER TABLE public.analytics_account_metrics_daily ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.analytics_account_metrics_daily TO service_role;
