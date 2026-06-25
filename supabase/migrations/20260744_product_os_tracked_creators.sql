-- ============================================================
-- Product OS — Watchlist de criadores (Fase E)
-- Acompanhar um designer inteiro: o lojista segue um criador (por plataforma +
-- nick) e o sistema lista os modelos dele ao vivo, ranqueados por popularidade,
-- já com o veredito de licença. Aditivo: 1 tabela.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.mw_tracked_creator (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  platform          TEXT NOT NULL,                 -- makerworld | thingiverse | cults3d
  handle            TEXT NOT NULL,                 -- nick/username do criador
  display_name      TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  last_model_count  INTEGER,
  notes             TEXT,
  created_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, platform, handle)
);
CREATE INDEX IF NOT EXISTS idx_mw_tracked_creator_org ON public.mw_tracked_creator (organization_id, is_active);

ALTER TABLE public.mw_tracked_creator ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mw_tracked_creator_select ON public.mw_tracked_creator;
CREATE POLICY mw_tracked_creator_select ON public.mw_tracked_creator FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS mw_tracked_creator_modify ON public.mw_tracked_creator;
CREATE POLICY mw_tracked_creator_modify ON public.mw_tracked_creator FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

GRANT ALL ON TABLE public.mw_tracked_creator TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mw_tracked_creator TO authenticated;
