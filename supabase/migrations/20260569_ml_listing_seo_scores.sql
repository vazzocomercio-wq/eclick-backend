-- F10 Passo 2 — tabela de scores SEO estruturais por anúncio.
--
-- Calculada por cron diário (listing-seo-scanner.service.ts) sem LLM:
-- mede título (length/CTR proxy), descrição (length + estrutura),
-- atributos (preenchidos vs catálogo), imagens (qtde + variação).
--
-- Serve pra:
--   1. Listar anúncios com SEO baixo (dashboard F10)
--   2. Gerar tasks `SEO_LOW` em ml_listing_tasks quando structural_score < 60
--   3. Prioritizar otimização por VISITAS × (100 - score) — alto tráfego e
--      score baixo = ROI máximo
--   4. Digest diário "Top 10 anúncios que mais ROI se otimizar"

CREATE TABLE IF NOT EXISTS public.ml_listing_seo_scores (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  seller_id       bigint NOT NULL,
  ml_item_id      text NOT NULL,

  -- Snapshot pra contexto e debugging (não usar como fonte canônica)
  title              text,
  title_length       int,
  pictures_count     int,
  attributes_count   int,                       -- total atributos preenchidos
  attributes_missing_required    int,
  attributes_missing_recommended int,
  has_description    boolean,
  description_length int,
  listing_type_id    text,
  catalog_listing    boolean,
  status             text,
  price              numeric,
  sold_quantity      int,

  -- Pra prioritização (Passo 3): visitas reais last 30 days
  visits_30d         int,

  -- Scores 0-100 — quanto maior, melhor
  title_score        int NOT NULL,
  description_score  int NOT NULL,
  attributes_score   int NOT NULL,
  pictures_score     int NOT NULL,
  structural_score   int NOT NULL,              -- média ponderada (peso ver scanner)

  -- Array de { code, area, severity, message } pra UI
  issues             jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Timestamps
  last_scanned_at    timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ml_listing_seo_scores_uniq UNIQUE (organization_id, seller_id, ml_item_id)
);

-- Index pra "top low-score" (dashboard F10)
CREATE INDEX IF NOT EXISTS idx_seo_scores_low
  ON public.ml_listing_seo_scores (organization_id, structural_score ASC, last_scanned_at DESC);

-- Index pra ranking visits × score (Passo 3 — Top ROI digest)
-- Expressão: visitas × penalidade-de-score = anúncios que estão sangrando tráfego
CREATE INDEX IF NOT EXISTS idx_seo_scores_priority
  ON public.ml_listing_seo_scores
     (organization_id, ((COALESCE(visits_30d, 0)) * (100 - structural_score)) DESC);

-- Index por seller (filtro multi-conta)
CREATE INDEX IF NOT EXISTS idx_seo_scores_seller
  ON public.ml_listing_seo_scores (organization_id, seller_id, structural_score ASC);

-- Grants (gotcha: tabela criada via _admin_exec_sql não recebe defaults)
GRANT ALL ON TABLE public.ml_listing_seo_scores TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ml_listing_seo_scores TO authenticated;

-- RLS multi-tenant
ALTER TABLE public.ml_listing_seo_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY ml_listing_seo_scores_org ON public.ml_listing_seo_scores
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

COMMENT ON TABLE public.ml_listing_seo_scores IS
  'F10 Passo 2 — score SEO estrutural por anúncio ML. Cron diário. Sem LLM. Usado pra tasks SEO_LOW + priorização visitas×score.';
