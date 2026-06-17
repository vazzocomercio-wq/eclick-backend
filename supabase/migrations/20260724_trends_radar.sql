-- Radar de Tendências de Produtos — Fase 1 (Mercado Livre).
--
-- Objetivo: descobrir o que está em ALTA no mercado (busca + best sellers)
-- e cruzar com viabilidade pra recomendar "comprar / observar / ignorar".
--
-- Mora em public.trends_* (prefixo) — schema público é sempre exposto no
-- PostgREST, sem dependência de config de schema exposto. Platform-agnostic
-- (ML agora; Shopee entra quando a Affiliate API for liberada).
--
-- 4 tabelas + 1 view:
--   trends_signals    — série temporal append-only (a DERIVADA mora aqui)
--   trends_products   — produto/keyword resolvido (entidade canônica)
--   trends_scores     — Trend Score + Buy Decision (1 por produto, upsert)
--   trends_watchlist  — o que o usuário marcou pra acompanhar/comprar
--   trends_settings   — categorias escaneadas + meta de margem por org
--   v_trends_radar    — join pronto pra tela

-- ── 1. SIGNALS (série temporal) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trends_signals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  platform        text NOT NULL DEFAULT 'mercado_livre'
                  CHECK (platform IN ('mercado_livre', 'shopee')),
  signal_type     text NOT NULL
                  CHECK (signal_type IN ('search_trend', 'best_seller', 'visits')),

  category_id     text,                 -- ML category (ex MLB1574); null = global
  category_name   text,
  term            text,                 -- keyword (search_trend)
  external_id     text,                 -- product/item id (best_seller/visits)
  position        int,                  -- ranking 1..N
  metric_value    numeric,              -- visitas, etc (shape depende do tipo)
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,

  captured_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.trends_signals IS
  'Radar de Tendências — captura crua append-only. Histórico por (org, platform, type, category/term/external_id, captured_at). Crescimento = derivada destas linhas.';

CREATE INDEX IF NOT EXISTS idx_trends_signals_org_type_cat
  ON public.trends_signals (organization_id, platform, signal_type, category_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_trends_signals_org_ext
  ON public.trends_signals (organization_id, external_id, captured_at DESC)
  WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trends_signals_org_term
  ON public.trends_signals (organization_id, term, captured_at DESC)
  WHERE term IS NOT NULL;

-- ── 2. PRODUCTS (entidade resolvida) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trends_products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  platform        text NOT NULL DEFAULT 'mercado_livre',
  external_id     text NOT NULL,        -- catalog product id (MLB...) ou slug da keyword
  kind            text NOT NULL DEFAULT 'catalog_product'
                  CHECK (kind IN ('catalog_product', 'keyword')),

  name            text NOT NULL,
  category_id     text,
  category_name   text,
  domain_id       text,
  price_ref_cents bigint,               -- preço de referência (buy box)
  status          text,
  thumbnail       text,
  url             text,

  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trends_products_uq UNIQUE (organization_id, platform, external_id)
);

COMMENT ON TABLE public.trends_products IS
  'Radar de Tendências — produto candidato (best seller) ou keyword em alta, resolvido e deduplicado por (org, platform, external_id).';

CREATE INDEX IF NOT EXISTS idx_trends_products_org_cat
  ON public.trends_products (organization_id, platform, category_id);

-- ── 3. SCORES (Trend Score + Buy Decision) ──────────────────────────
CREATE TABLE IF NOT EXISTS public.trends_scores (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_id          uuid NOT NULL REFERENCES public.trends_products(id) ON DELETE CASCADE,

  trend_score         numeric NOT NULL DEFAULT 0,    -- 0-100
  momentum            numeric NOT NULL DEFAULT 0,    -- componente (derivada)
  volume_score        numeric NOT NULL DEFAULT 0,
  breadth_score       numeric NOT NULL DEFAULT 0,
  best_seller_rank    int,
  rank_delta          int,                            -- subiu (+) / caiu (-) no ranking

  buy_decision        text NOT NULL DEFAULT 'observar'
                      CHECK (buy_decision IN ('comprar', 'observar', 'ignorar')),
  margin_estimate_pct numeric,                        -- null = custo a validar
  confidence          numeric NOT NULL DEFAULT 0.5,
  ai_rationale        text,
  components          jsonb NOT NULL DEFAULT '{}'::jsonb,

  computed_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trends_scores_uq UNIQUE (organization_id, product_id)
);

COMMENT ON TABLE public.trends_scores IS
  'Radar de Tendências — Trend Score determinístico + Buy Decision (comprar/observar/ignorar) com racional IA. 1 linha por produto (upsert).';

-- ── 4. WATCHLIST ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trends_watchlist (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES public.trends_products(id) ON DELETE CASCADE,
  decision        text DEFAULT 'observando'
                  CHECK (decision IN ('comprando', 'observando', 'descartado')),
  note            text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trends_watchlist_uq UNIQUE (organization_id, product_id)
);

COMMENT ON TABLE public.trends_watchlist IS
  'Radar de Tendências — produtos que o usuário marcou (comprando/observando/descartado).';

-- ── 5. SETTINGS (categorias escaneadas + meta) ──────────────────────
CREATE TABLE IF NOT EXISTS public.trends_settings (
  organization_id   uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  platform          text NOT NULL DEFAULT 'mercado_livre',
  categories        text[] NOT NULL DEFAULT '{}',   -- ML category ids escaneadas
  target_margin_pct numeric NOT NULL DEFAULT 15,    -- meta de margem pra "comprar"
  auto_enabled      boolean NOT NULL DEFAULT false, -- cron diário liga/desliga
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.trends_settings IS
  'Radar de Tendências — configuração por org: categorias ML escaneadas, meta de margem, e se o cron diário roda.';

-- ── 6. VIEW radar (join pronto pra tela) ────────────────────────────
CREATE OR REPLACE VIEW public.v_trends_radar AS
SELECT
  p.id              AS product_id,
  p.organization_id,
  p.platform,
  p.external_id,
  p.kind,
  p.name,
  p.category_id,
  p.category_name,
  p.domain_id,
  p.price_ref_cents,
  p.status,
  p.thumbnail,
  p.url,
  p.first_seen_at,
  p.last_seen_at,
  s.trend_score,
  s.momentum,
  s.volume_score,
  s.breadth_score,
  s.best_seller_rank,
  s.rank_delta,
  s.buy_decision,
  s.margin_estimate_pct,
  s.confidence,
  s.ai_rationale,
  s.components,
  s.computed_at,
  (w.id IS NOT NULL) AS in_watchlist,
  w.decision         AS watch_decision
FROM public.trends_products p
LEFT JOIN public.trends_scores    s ON s.product_id = p.id
LEFT JOIN public.trends_watchlist w ON w.product_id = p.id;

COMMENT ON VIEW public.v_trends_radar IS
  'Radar de Tendências — produto + score + flag de watchlist, pronto pra listagem na tela.';

-- ── 7. RLS + GRANTS ─────────────────────────────────────────────────
ALTER TABLE public.trends_signals   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trends_products  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trends_scores    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trends_watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trends_settings  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trends_signals','trends_products','trends_scores','trends_watchlist','trends_settings']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "org members %1$s read" ON public.%1$s', t);
    EXECUTE format($f$
      CREATE POLICY "org members %1$s read" ON public.%1$s FOR SELECT
      USING (organization_id IN (
        SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
      ))
    $f$, t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', t);
  END LOOP;
END $$;

GRANT SELECT ON public.v_trends_radar TO authenticated, service_role;
