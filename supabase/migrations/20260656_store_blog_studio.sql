-- ═══════════════════════════════════════════════════
-- 20260656: Blog da Loja — Estúdio (voz + prompts editáveis + conhecimento + fonte)
--  store_blog_settings: 1 linha por org (voz da marca, overrides de system
--    prompt article/ideate, display_font = key de fontPair pra vitrine).
--  store_blog_knowledge: URLs/notas de referência injetadas na geração.
-- ═══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.store_blog_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  voice           text,            -- tom/diretrizes da marca pro blog
  prompt_article  text,            -- override do system prompt do artigo
  prompt_ideate   text,            -- override do system prompt de pautas
  display_font    text,            -- key de fontPair (font-pairs v3) pros títulos do blog; null = herda o tema
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.store_blog_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "org members store_blog_settings" ON public.store_blog_settings;
CREATE POLICY "org members store_blog_settings"
  ON public.store_blog_settings FOR ALL
  USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
GRANT ALL ON public.store_blog_settings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_blog_settings TO authenticated;

CREATE TABLE IF NOT EXISTS public.store_blog_knowledge (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_type     text NOT NULL CHECK (source_type IN ('url','text')),
  value           text NOT NULL,
  title           text,
  extracted_text  text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_blog_knowledge_org_idx ON public.store_blog_knowledge(organization_id);

ALTER TABLE public.store_blog_knowledge ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "org members store_blog_knowledge" ON public.store_blog_knowledge;
CREATE POLICY "org members store_blog_knowledge"
  ON public.store_blog_knowledge FOR ALL
  USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
GRANT ALL ON public.store_blog_knowledge TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_blog_knowledge TO authenticated;

COMMENT ON TABLE public.store_blog_settings IS 'Estúdio do Blog da Loja: voz, overrides de prompt, fonte (key fontPair). 1 linha/org.';
COMMENT ON TABLE public.store_blog_knowledge IS 'Base de conhecimento do Blog da Loja (URLs/notas) injetada na geração.';
