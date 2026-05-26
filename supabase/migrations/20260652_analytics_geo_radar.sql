-- ═══════════════════════════════════════════════════
-- 20260652: Analytics Hub — GEO Radar (F3)
-- Mede se a marca/produtos aparecem e são citados nas respostas dos motores
-- de IA (Gemini/OpenAI/Claude) para queries de comprador. Share-of-voice em IA.
-- Reusa tracked_queries/tracked_products (ai-visibility). Leitura backend-gated.
-- ═══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.analytics_geo_radar_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  query_id uuid,                          -- ref lógica tracked_queries.id
  query text NOT NULL,
  engine text NOT NULL,                   -- gemini | openai | claude
  date date NOT NULL,

  mentioned boolean NOT NULL DEFAULT false,    -- marca/produto citado na resposta?
  brand_cited boolean NOT NULL DEFAULT false,  -- domínio/marca nas FONTES citadas?
  position int,                                -- ordem da 1ª menção (1=primeiro); null se ausente
  answer_excerpt text,                         -- trecho da resposta da IA
  citations jsonb NOT NULL DEFAULT '[]',       -- [{url,title}] das fontes citadas
  raw jsonb NOT NULL DEFAULT '{}',
  cost_usd numeric(10,4) NOT NULL DEFAULT 0,
  error text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_id, query, engine, date)
);

CREATE INDEX IF NOT EXISTS idx_agrr_org_date
  ON public.analytics_geo_radar_runs (organization_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_agrr_org_engine
  ON public.analytics_geo_radar_runs (organization_id, engine, date DESC);

ALTER TABLE public.analytics_geo_radar_runs ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.analytics_geo_radar_runs TO service_role;
