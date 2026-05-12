-- ============================================
-- F6 Sprint 2 — Patch (post-2.5)
-- Tabela de taxonomia customizável: ambient + product_type
-- Seguindo a Opção C (híbrido inline-create):
--   - Defaults globais (org_id=NULL) seedados aqui
--   - Cada org pode adicionar/editar/apagar SUAS opções
--   - Defaults nunca são editáveis por user (só via service_role)
-- ============================================

CREATE TABLE IF NOT EXISTS public.creative_taxonomy_options (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- NULL = default global da plataforma (visível a todas as orgs)
  kind             text NOT NULL CHECK (kind IN ('ambient', 'product_type')),
  value            text NOT NULL,         -- snake_case key (persistido em creative_reference_images.ambient/product_type)
  label            text NOT NULL,         -- display name (com acento, capitalize)
  sort_order       int  NOT NULL DEFAULT 0,
  is_default       boolean NOT NULL DEFAULT false,   -- true = seed da plataforma; false = customizado pela org
  created_by       uuid REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Unique: (org_id_normalizado, kind, value) — evita duplicates
-- COALESCE pra NULL virar uma uuid fixa "zero" pra unique index funcionar.
CREATE UNIQUE INDEX IF NOT EXISTS ux_taxonomy_org_kind_value
  ON public.creative_taxonomy_options (
    COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    kind,
    value
  );

CREATE INDEX IF NOT EXISTS ix_taxonomy_kind_org_sort
  ON public.creative_taxonomy_options (kind, organization_id, sort_order ASC, label ASC);

-- Auto-update do updated_at
CREATE OR REPLACE FUNCTION public.touch_taxonomy_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_taxonomy_touch ON public.creative_taxonomy_options;
CREATE TRIGGER trg_taxonomy_touch
  BEFORE UPDATE ON public.creative_taxonomy_options
  FOR EACH ROW EXECUTE FUNCTION public.touch_taxonomy_updated_at();

-- ============================================
-- RLS
-- ============================================
ALTER TABLE public.creative_taxonomy_options ENABLE ROW LEVEL SECURITY;

-- SELECT: defaults globais OU itens da própria org
DROP POLICY IF EXISTS taxonomy_select ON public.creative_taxonomy_options;
CREATE POLICY taxonomy_select ON public.creative_taxonomy_options
  FOR SELECT USING (
    organization_id IS NULL
    OR organization_id IN (
      SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  );

-- INSERT: só dentro da própria org (não permite inserir default global via API)
DROP POLICY IF EXISTS taxonomy_insert ON public.creative_taxonomy_options;
CREATE POLICY taxonomy_insert ON public.creative_taxonomy_options
  FOR INSERT WITH CHECK (
    organization_id IS NOT NULL
    AND is_default = false
    AND organization_id IN (
      SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  );

-- UPDATE: só itens não-default da própria org
DROP POLICY IF EXISTS taxonomy_update ON public.creative_taxonomy_options;
CREATE POLICY taxonomy_update ON public.creative_taxonomy_options
  FOR UPDATE USING (
    organization_id IS NOT NULL
    AND is_default = false
    AND organization_id IN (
      SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  );

-- DELETE: idem
DROP POLICY IF EXISTS taxonomy_delete ON public.creative_taxonomy_options;
CREATE POLICY taxonomy_delete ON public.creative_taxonomy_options
  FOR DELETE USING (
    organization_id IS NOT NULL
    AND is_default = false
    AND organization_id IN (
      SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  );

-- GRANTs (per memory rule: tabelas criadas via _admin_exec_sql NÃO recebem default privileges)
GRANT ALL ON public.creative_taxonomy_options TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.creative_taxonomy_options TO authenticated;

-- ============================================
-- SEED — Defaults globais (org_id=NULL)
-- Espelha a lista que estava hardcoded em ReferenceFilters/ReferenceEditorDrawer.
-- sort_order distribui 10/20/30… pra permitir inserções intermediárias depois.
-- ============================================
INSERT INTO public.creative_taxonomy_options (organization_id, kind, value, label, sort_order, is_default) VALUES
  -- Ambientes (15 opções)
  (NULL, 'ambient', 'sala',                    'Sala',                       10, true),
  (NULL, 'ambient', 'sala_estar',              'Sala de estar',              20, true),
  (NULL, 'ambient', 'sala_jantar',             'Sala de jantar',             30, true),
  (NULL, 'ambient', 'quarto',                  'Quarto',                     40, true),
  (NULL, 'ambient', 'cozinha',                 'Cozinha',                    50, true),
  (NULL, 'ambient', 'banheiro',                'Banheiro',                   60, true),
  (NULL, 'ambient', 'gourmet',                 'Gourmet',                    70, true),
  (NULL, 'ambient', 'varanda',                 'Varanda',                    80, true),
  (NULL, 'ambient', 'escritorio',              'Escritório',                 90, true),
  (NULL, 'ambient', 'externa',                 'Externa',                   100, true),
  (NULL, 'ambient', 'estudio',                 'Estúdio',                   110, true),
  (NULL, 'ambient', 'neutro',                  'Neutro',                    120, true),
  (NULL, 'ambient', 'capa',                    'Capa',                      130, true),
  (NULL, 'ambient', 'embalagem',               'Embalagem',                 140, true),
  (NULL, 'ambient', 'caracteristicas_medidas', 'Características / medidas', 150, true),
  (NULL, 'ambient', 'detalhes',                'Detalhes',                  160, true),
  -- Product types (7 opções)
  (NULL, 'product_type', 'lustre',    'Lustre',     10, true),
  (NULL, 'product_type', 'pendente',  'Pendente',   20, true),
  (NULL, 'product_type', 'abajur',    'Abajur',     30, true),
  (NULL, 'product_type', 'plafon',    'Plafon',     40, true),
  (NULL, 'product_type', 'spot',      'Spot',       50, true),
  (NULL, 'product_type', 'arandela',  'Arandela',   60, true),
  (NULL, 'product_type', 'outro',     'Outro',      70, true)
ON CONFLICT DO NOTHING;
