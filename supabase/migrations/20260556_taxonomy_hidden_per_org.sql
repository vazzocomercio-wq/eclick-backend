-- ============================================
-- F6 Sprint 2 — Patch 3 (UX: esconder defaults por org)
-- User pediu poder "apagar" defaults globais. Defaults são compartilhados
-- entre orgs (NÃO podemos fazer DELETE real). Solução: tabela auxiliar
-- de "ocultas" — cada org marca individualmente quais defaults quer esconder
-- da SUA lista.
--
-- Customs da org continuam com DELETE real (sem entrar nessa tabela).
-- ============================================

CREATE TABLE IF NOT EXISTS public.creative_taxonomy_hidden (
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  taxonomy_id      uuid NOT NULL REFERENCES public.creative_taxonomy_options(id) ON DELETE CASCADE,
  hidden_at        timestamptz NOT NULL DEFAULT now(),
  hidden_by        uuid REFERENCES auth.users(id),
  PRIMARY KEY (organization_id, taxonomy_id)
);

CREATE INDEX IF NOT EXISTS ix_taxonomy_hidden_org
  ON public.creative_taxonomy_hidden (organization_id);

-- RLS
ALTER TABLE public.creative_taxonomy_hidden ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS taxonomy_hidden_select ON public.creative_taxonomy_hidden;
CREATE POLICY taxonomy_hidden_select ON public.creative_taxonomy_hidden
  FOR SELECT USING (
    organization_id IN (
      SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS taxonomy_hidden_insert ON public.creative_taxonomy_hidden;
CREATE POLICY taxonomy_hidden_insert ON public.creative_taxonomy_hidden
  FOR INSERT WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS taxonomy_hidden_delete ON public.creative_taxonomy_hidden;
CREATE POLICY taxonomy_hidden_delete ON public.creative_taxonomy_hidden
  FOR DELETE USING (
    organization_id IN (
      SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  );

-- GRANTs (per memory rule)
GRANT ALL ON public.creative_taxonomy_hidden TO service_role;
GRANT SELECT, INSERT, DELETE ON public.creative_taxonomy_hidden TO authenticated;
