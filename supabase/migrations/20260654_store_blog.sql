-- ═══════════════════════════════════════════════════
-- 20260654: Blog da Loja — pipeline de conteúdo do storefront gerado por IA
--
-- Feature SaaS multi-tenant: cada loja (org) ganha um blog integrado à vitrine
-- (/loja/[slug]/blog), GEO-otimizado e CIENTE DOS PRODUTOS da loja. A IA gera
-- artigo + capa → fila de revisão → aprovado/agendado → publicado. Diferente
-- do blog da e-Click (Sanity): este renderiza direto do SaaS, com o tema da
-- loja. Detalhes em memory/project_blog_geo.md (épico SB).
-- ═══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.store_blog_posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by      uuid,

  -- ── conteúdo ─────────────────────────────────────────────────────
  title            text NOT NULL,
  slug             text NOT NULL,
  excerpt          text,
  tldr             jsonb NOT NULL DEFAULT '[]',           -- string[]
  body             jsonb NOT NULL DEFAULT '[]',           -- Portable Text-like blocks
  faq              jsonb NOT NULL DEFAULT '[]',           -- [{question, answer}]
  ai_prompts       jsonb NOT NULL DEFAULT '[]',           -- string[] (perguntas que o post responde — GEO)
  citation_sources jsonb NOT NULL DEFAULT '[]',           -- [{title, url, authorOrOrg, year}]
  category         text,                                   -- categoria/tema livre
  tags             jsonb NOT NULL DEFAULT '[]',           -- string[]
  featured_product_ids jsonb NOT NULL DEFAULT '[]',       -- uuid[] dos produtos apresentados no artigo
  cover_image_url  text,
  seo_title        text,
  meta_description text,
  focus_keyword    text,
  reading_time_minutes int,

  -- ── pipeline ─────────────────────────────────────────────────────
  status           text NOT NULL DEFAULT 'generating'
    CHECK (status IN ('generating','review','approved','scheduled','published','failed','archived')),
  scheduled_for    timestamptz,
  published_at     timestamptz,
  rejected_reason  text,

  -- ── origem / IA ──────────────────────────────────────────────────
  source_topic     text,
  cost_usd         numeric(12,6) NOT NULL DEFAULT 0,
  generation_metadata jsonb NOT NULL DEFAULT '{}',

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS store_blog_posts_org_idx    ON public.store_blog_posts(organization_id);
CREATE INDEX IF NOT EXISTS store_blog_posts_status_idx ON public.store_blog_posts(organization_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS store_blog_posts_org_slug_uidx ON public.store_blog_posts(organization_id, slug);
CREATE INDEX IF NOT EXISTS store_blog_posts_scheduled_idx ON public.store_blog_posts(scheduled_for)
  WHERE status = 'scheduled';
-- listagem pública da vitrine: publicados por org, mais recentes primeiro
CREATE INDEX IF NOT EXISTS store_blog_posts_published_idx ON public.store_blog_posts(organization_id, published_at DESC)
  WHERE status = 'published';

-- ── RLS (padrão SaaS via organization_members) ───────────────────────
ALTER TABLE public.store_blog_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members store_blog_posts" ON public.store_blog_posts;
CREATE POLICY "org members store_blog_posts"
  ON public.store_blog_posts FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

-- ⚠️ Tabela criada via _admin_exec_sql não herda os default grants do Supabase
-- (gotcha conhecido). GRANT explícito senão authenticated/service_role batem
-- em "permission denied" antes da RLS rodar.
GRANT ALL ON public.store_blog_posts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_blog_posts TO authenticated;

COMMENT ON TABLE public.store_blog_posts IS
  'Blog da loja (storefront) gerado por IA, GEO + ciente dos produtos. Renderiza direto do SaaS na vitrine /loja/[slug]/blog (não usa Sanity). Pipeline review→published.';
