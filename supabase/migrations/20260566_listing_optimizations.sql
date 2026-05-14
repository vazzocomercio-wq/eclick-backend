-- e-Otimizer IA MVP 4 — tabela de tracking de otimizações de anúncios EXISTENTES
--
-- Registra cada análise + (opcionalmente) aplicação de otimização em
-- anúncios já publicados no ML. Base pro MVP 5 (feedback loop antes/depois).

CREATE TABLE IF NOT EXISTS public.listing_optimizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  mlb_id          text NOT NULL,
  category_ml_id  text,

  -- Snapshot ANTES de otimizar
  before_snapshot jsonb NOT NULL,    -- { title, description, attributes, sold_quantity, listing_type_id, price, pictures }
  permissions     jsonb NOT NULL,    -- { title: 'free'|'restricted'|'locked', description: ..., attributes: ..., category: ... }

  -- Score SEO calculado (0-100)
  seo_score_before int,

  -- Sugestões da IA
  suggestions     jsonb NOT NULL,    -- { title?, description?, attributes?, clone_title? }
  research_payload jsonb,            -- snapshot do CategoryResearch usado (rastreabilidade)
  hard_rules_applied text[],         -- regras duras aplicadas no prompt

  -- Aplicação (preenchido só se user aplicou)
  applied_at      timestamptz,
  applied_fields  text[],            -- ex: ['description', 'attributes']
  after_snapshot  jsonb,
  seo_score_after int,
  ml_response     jsonb,             -- response do PUT /items/{id} (ou erro)

  -- Tracking pro feedback loop MVP 5
  metrics_t0       jsonb,            -- visits/sold no momento de aplicar
  metrics_t7d      jsonb,
  metrics_t14d     jsonb,
  metrics_t30d     jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_optimizations_org_mlb
  ON public.listing_optimizations (organization_id, mlb_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listing_optimizations_applied
  ON public.listing_optimizations (organization_id, applied_at DESC) WHERE applied_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listing_optimizations_for_feedback
  ON public.listing_optimizations (applied_at) WHERE applied_at IS NOT NULL AND metrics_t30d IS NULL;

-- Grants (tabela via _admin_exec_sql não recebe defaults)
GRANT ALL ON TABLE public.listing_optimizations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.listing_optimizations TO authenticated;

-- RLS multi-tenant
ALTER TABLE public.listing_optimizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY listing_optimizations_org ON public.listing_optimizations
  FOR ALL TO authenticated
  USING (organization_id = (SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()));

COMMENT ON TABLE public.listing_optimizations IS
  'e-Otimizer IA MVP 4 — histórico de otimizações em anúncios ML existentes. Snapshots ANTES + sugestões + APÓS + métricas pro feedback loop.';
