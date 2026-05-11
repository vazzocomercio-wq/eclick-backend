-- ============================================
-- F6 Sprint 2 — Migration 1/6
-- Prompt templates por position + Reference library
-- ============================================

-- ============================================
-- TABLE 1: creative_image_prompt_templates
-- ============================================
CREATE TABLE IF NOT EXISTS public.creative_image_prompt_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,                       -- "Esteira Lustres Vazzo"
  description     text,
  is_default      boolean NOT NULL DEFAULT false,      -- 1 default por org (constraint abaixo)
  category_ml_ids text[] NOT NULL DEFAULT '{}',        -- vazio = template global; preenchido = match por categoria
  brand_voice     text,                                -- "Premium, refinado, minimalista" — guia transversal
  positions       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- array de TemplatePosition (validação na app)
  created_by      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Constraint: 1 default por org
CREATE UNIQUE INDEX IF NOT EXISTS ux_template_default_per_org
  ON public.creative_image_prompt_templates (organization_id)
  WHERE is_default = true;

-- GIN pra match rápido por categoria
CREATE INDEX IF NOT EXISTS ix_template_category_match
  ON public.creative_image_prompt_templates USING GIN (category_ml_ids);

CREATE INDEX IF NOT EXISTS ix_template_org_created
  ON public.creative_image_prompt_templates (organization_id, created_at DESC);

-- Sanity check leve do jsonb (não força schema interno; isso fica a cargo da app)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_template_positions_is_array'
      AND conrelid = 'public.creative_image_prompt_templates'::regclass
  ) THEN
    ALTER TABLE public.creative_image_prompt_templates
      ADD CONSTRAINT ck_template_positions_is_array
      CHECK (jsonb_typeof(positions) = 'array');
  END IF;
END $$;

-- Trigger updated_at
CREATE OR REPLACE FUNCTION public.tg_template_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_template_updated_at ON public.creative_image_prompt_templates;
CREATE TRIGGER trg_template_updated_at
  BEFORE UPDATE ON public.creative_image_prompt_templates
  FOR EACH ROW EXECUTE FUNCTION public.tg_template_updated_at();

-- RLS
ALTER TABLE public.creative_image_prompt_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS template_org_select ON public.creative_image_prompt_templates;
CREATE POLICY template_org_select
  ON public.creative_image_prompt_templates FOR SELECT
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS template_org_modify ON public.creative_image_prompt_templates;
CREATE POLICY template_org_modify
  ON public.creative_image_prompt_templates FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ))
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS template_service_role_all ON public.creative_image_prompt_templates;
CREATE POLICY template_service_role_all
  ON public.creative_image_prompt_templates FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.creative_image_prompt_templates IS
  'F6 Sprint 2: templates de prompt por position. Cada template tem N positions (1..11) com prompt_template, negative_prompt, refs e flags. is_default=true marca o template padrão da org. category_ml_ids vazio = template global; preenchido = template específico de categoria.';

COMMENT ON COLUMN public.creative_image_prompt_templates.positions IS
  'jsonb array de TemplatePosition: { position, name, prompt_template, negative_prompt, use_product_reference, use_brand_logo, use_reference_ids[], reference_match{}, ambient_hint, aspect_ratio }. Variáveis interpoláveis: {product_name}, {material}, {primary_color}, {dimensions}, {category_label}, {brand_name}, {detected_parts}, {usage_contexts}.';

-- ============================================
-- TABLE 2: creative_reference_images
-- ============================================
CREATE TABLE IF NOT EXISTS public.creative_reference_images (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,  -- NULL = curado plataforma
  is_curated      boolean NOT NULL DEFAULT false,                              -- true = compartilhado entre todas as orgs
  name            text NOT NULL,
  description     text,
  storage_bucket  text NOT NULL DEFAULT 'creative-references',
  storage_path    text NOT NULL,                       -- bucket/orgId/uuid.jpg ou bucket/curated/uuid.jpg
  tags            text[] NOT NULL DEFAULT '{}',
  category_ml_ids text[] NOT NULL DEFAULT '{}',
  default_for_positions integer[] NOT NULL DEFAULT '{}', -- ex: [2,4,6]
  product_type    text,                                -- 'lustre'/'abajur'/'pendente'/'plafon' etc
  ambient         text,                                -- 'sala'/'quarto'/'cozinha'/'gourmet'/'escritorio'
  is_active       boolean NOT NULL DEFAULT true,
  width           integer,
  height          integer,
  size_bytes      bigint,
  mime_type       text,
  uploaded_by     uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Curated → sem org. User upload → com org. Não tem meio termo.
  CONSTRAINT ck_ref_curated_xor_org CHECK (
    (is_curated = true AND organization_id IS NULL) OR
    (is_curated = false AND organization_id IS NOT NULL)
  )
);

-- Índices
CREATE INDEX IF NOT EXISTS ix_ref_org_active
  ON public.creative_reference_images (organization_id, is_active)
  WHERE is_curated = false;

CREATE INDEX IF NOT EXISTS ix_ref_curated_active
  ON public.creative_reference_images (is_active)
  WHERE is_curated = true;

CREATE INDEX IF NOT EXISTS ix_ref_tags
  ON public.creative_reference_images USING GIN (tags);

CREATE INDEX IF NOT EXISTS ix_ref_categories
  ON public.creative_reference_images USING GIN (category_ml_ids);

CREATE INDEX IF NOT EXISTS ix_ref_positions
  ON public.creative_reference_images USING GIN (default_for_positions);

CREATE INDEX IF NOT EXISTS ix_ref_product_type
  ON public.creative_reference_images (product_type)
  WHERE is_active = true;

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_ref_updated_at ON public.creative_reference_images;
CREATE TRIGGER trg_ref_updated_at
  BEFORE UPDATE ON public.creative_reference_images
  FOR EACH ROW EXECUTE FUNCTION public.tg_template_updated_at();

-- RLS
ALTER TABLE public.creative_reference_images ENABLE ROW LEVEL SECURITY;

-- SELECT: vê (a) suas próprias + (b) curated ativas
DROP POLICY IF EXISTS ref_select ON public.creative_reference_images;
CREATE POLICY ref_select
  ON public.creative_reference_images FOR SELECT
  USING (
    (is_curated = true AND is_active = true)
    OR organization_id IN (
      SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  );

-- INSERT/UPDATE/DELETE: só nas suas próprias (curated é gerenciado por service_role)
DROP POLICY IF EXISTS ref_org_modify ON public.creative_reference_images;
CREATE POLICY ref_org_modify
  ON public.creative_reference_images FOR ALL
  USING (
    is_curated = false
    AND organization_id IN (
      SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    is_curated = false
    AND organization_id IN (
      SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS ref_service_role_all ON public.creative_reference_images;
CREATE POLICY ref_service_role_all
  ON public.creative_reference_images FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.creative_reference_images IS
  'F6 Sprint 2: galeria de imagens de referência. is_curated=true → compartilhada plataforma (sem org). is_curated=false → upload do user com org dono. Pipeline busca refs com match por: tags, category_ml_ids, default_for_positions, product_type, ambient. Usadas como inline_data (Gemini) ou source URLs (OpenAI) na geração.';

-- ============================================
-- Storage bucket
-- ============================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'creative-references',
  'creative-references',
  false,
  10 * 1024 * 1024,  -- 10MB cap por imagem
  ARRAY['image/jpeg','image/png','image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- GRANTs (memory rule: tabelas criadas via _admin_exec_sql NÃO recebem
-- default privileges, então RLS sem GRANT = "permission denied" antes
-- da policy avaliar)
-- ============================================
GRANT ALL ON public.creative_image_prompt_templates TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.creative_image_prompt_templates TO authenticated;

GRANT ALL ON public.creative_reference_images TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.creative_reference_images TO authenticated;
