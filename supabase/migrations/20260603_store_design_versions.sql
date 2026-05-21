-- Store Builder v3 — Versionamento (Fase E).
--
-- Cada save manual do Designer cria uma row aqui. Quando o lojista clica
-- "Publicar", a version mais recente vira a `current` (espelhada em
-- store_config.design_v3). Versions anteriores ficam como historico
-- pra revert.
--
-- Estrategia simples:
--  - store_config.design_v3 sempre tem o design "publicado" (o que a
--    vitrine publica renderiza).
--  - store_design_versions guarda snapshots: cada save manual ou
--    publish cria 1 row. Lojista pode browsear historico e restaurar.

CREATE TABLE IF NOT EXISTS public.store_design_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  design            jsonb NOT NULL,
  label             text,
  source            text NOT NULL CHECK (source IN ('manual_save', 'ai_generated', 'template_applied', 'publish')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS store_design_versions_org_created_idx
  ON public.store_design_versions (organization_id, created_at DESC);

ALTER TABLE public.store_design_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sdv_select_own ON public.store_design_versions;
CREATE POLICY sdv_select_own ON public.store_design_versions FOR SELECT
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS sdv_insert_own ON public.store_design_versions;
CREATE POLICY sdv_insert_own ON public.store_design_versions FOR INSERT
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

GRANT ALL ON TABLE public.store_design_versions TO service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.store_design_versions TO authenticated;

COMMENT ON TABLE  public.store_design_versions IS 'Historico de designs v3 por org. Cada save gera 1 snapshot. Permite revert.';
COMMENT ON COLUMN public.store_design_versions.source IS 'manual_save | ai_generated | template_applied | publish';
