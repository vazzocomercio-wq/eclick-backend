-- e-Otimizer IA MVP 1 — tabela de cache do Research Engine
--
-- Pra cada (org, categoria, query) guarda o payload completo do research:
--   - top 20 competidores escolhidos (rastreabilidade)
--   - keywords frequentes com sources_mlb[]
--   - padrão de título detectado
--   - stats de atributos e mercado
--
-- TTL: 24h via expires_at (consulta filtra na leitura).
-- organization_id NULL = cache compartilhado (mercado público).

CREATE TABLE IF NOT EXISTS public.ml_category_research (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  category_ml_id  text NOT NULL,
  search_query    text NOT NULL,

  -- Payload do CategoryResearch (e-otimizer.types.ts) inteiro
  payload         jsonb NOT NULL,

  -- Filtros de exclusão aplicados (debugging)
  filter_reasons  jsonb NOT NULL DEFAULT '{}'::jsonb,

  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Unique por chave de cache. organization_id NULL é tratado como valor distinto
-- via expression-based unique constraint (PostgreSQL).
CREATE UNIQUE INDEX IF NOT EXISTS ux_ml_category_research_key
  ON public.ml_category_research (
    COALESCE(organization_id::text, '__GLOBAL__'),
    category_ml_id,
    search_query
  );

-- Lookup rápido por categoria (debug + analytics)
CREATE INDEX IF NOT EXISTS idx_ml_category_research_cat
  ON public.ml_category_research (category_ml_id, created_at DESC);

-- Lookup pra cleanup de expirados
CREATE INDEX IF NOT EXISTS idx_ml_category_research_expires
  ON public.ml_category_research (expires_at);

-- ── Grants (tabela criada via _admin_exec_sql NÃO recebe default privileges)
GRANT ALL ON TABLE public.ml_category_research TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ml_category_research TO authenticated;

-- ── RLS: vendor próprio só vê seus caches + os globais
ALTER TABLE public.ml_category_research ENABLE ROW LEVEL SECURITY;

CREATE POLICY ml_category_research_read ON public.ml_category_research
  FOR SELECT TO authenticated
  USING (
    organization_id IS NULL
    OR organization_id = (SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid())
  );

CREATE POLICY ml_category_research_write ON public.ml_category_research
  FOR INSERT TO authenticated
  WITH CHECK (
    organization_id IS NULL
    OR organization_id = (SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid())
  );

CREATE POLICY ml_category_research_update ON public.ml_category_research
  FOR UPDATE TO authenticated
  USING (
    organization_id IS NULL
    OR organization_id = (SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid())
  );

COMMENT ON TABLE public.ml_category_research IS
  'e-Otimizer IA — cache 24h de research de categorias ML. NULL org = cache global compartilhado.';
