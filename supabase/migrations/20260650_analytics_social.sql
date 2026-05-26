-- ═══════════════════════════════════════════════════
-- 20260650: Analytics Hub — coleta orgânica de redes sociais (F1)
-- O SaaS coleta direto via token Meta próprio (social_commerce_channels),
-- TODO o feed (posts/reels nativos + publicados pelo e-Click) por conta IG.
-- Multi-conta/multi-rede. Leitura backend-gated (GRANT só service_role,
-- RLS default-deny) — igual ao módulo ai-visibility.
-- ═══════════════════════════════════════════════════

-- ─── 1. analytics_social_posts ───────────────────────
-- 1 linha por (org, conta, post). Catálogo do conteúdo + último snapshot.
CREATE TABLE IF NOT EXISTS public.analytics_social_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  network text NOT NULL,                  -- instagram | facebook | ...
  account_external_id text NOT NULL,      -- ig user id / page id
  external_post_id text NOT NULL,         -- ig media id

  media_type text,                        -- IMAGE | VIDEO | CAROUSEL_ALBUM
  media_product_type text,                -- FEED | REELS | STORY | AD
  permalink text,
  caption text,
  thumbnail_url text,
  media_url text,
  published_at timestamptz,
  source text NOT NULL DEFAULT 'native',  -- native | eclick

  -- Último snapshot das métricas (pra listar sem join na _daily)
  latest_metrics jsonb NOT NULL DEFAULT '{}',
  insights_available boolean NOT NULL DEFAULT false,

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_id, account_external_id, external_post_id)
);

CREATE INDEX IF NOT EXISTS idx_asp_org_pub
  ON public.analytics_social_posts (organization_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_asp_org_acct
  ON public.analytics_social_posts (organization_id, network, account_external_id);

-- ─── 2. analytics_social_metrics_daily ───────────────
-- 1 linha por (post, dia). Insights do IG são cumulativos por post; o
-- snapshot diário deixa a gente ver evolução/deltas ao longo do tempo.
CREATE TABLE IF NOT EXISTS public.analytics_social_metrics_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES public.analytics_social_posts(id) ON DELETE CASCADE,

  network text NOT NULL,
  account_external_id text NOT NULL,
  external_post_id text NOT NULL,
  date date NOT NULL,

  reach bigint NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  likes bigint NOT NULL DEFAULT 0,
  comments bigint NOT NULL DEFAULT 0,
  shares bigint NOT NULL DEFAULT 0,
  saved bigint NOT NULL DEFAULT 0,
  video_views bigint NOT NULL DEFAULT 0,
  total_interactions bigint NOT NULL DEFAULT 0,

  -- (likes + comments + shares + saved) / reach — calculado no código (evita div/0)
  engagement_rate numeric(8,4) NOT NULL DEFAULT 0,

  raw_metrics jsonb NOT NULL DEFAULT '{}',

  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (post_id, date)
);

CREATE INDEX IF NOT EXISTS idx_asmd_org_date
  ON public.analytics_social_metrics_daily (organization_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_asmd_post
  ON public.analytics_social_metrics_daily (post_id, date DESC);

-- ─── 3. RLS default-deny + GRANT só service_role ─────
-- Leitura via backend (service_role BYPASSRLS) filtrando org_id do JWT.
-- Sem policy pra authenticated → frontend não lê direto (anti-vazamento).
ALTER TABLE public.analytics_social_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_social_metrics_daily ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.analytics_social_posts TO service_role;
GRANT ALL ON TABLE public.analytics_social_metrics_daily TO service_role;
