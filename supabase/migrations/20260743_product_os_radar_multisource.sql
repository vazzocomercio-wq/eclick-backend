-- ============================================================
-- Product OS — Radar multi-fonte (fundação)
-- O radar deixa de ser só MakerWorld: cada item carrega a PLATAFORMA de origem
-- e o VEREDITO de licença gravado no momento da leitura (platform-agnostic, o
-- viewOf confia nele em vez de reparsear). A unicidade passa a incluir a
-- plataforma (mesmo external_id pode existir em MakerWorld e Thingiverse).
-- Aditivo: 2 colunas + troca de constraint.
-- ============================================================
ALTER TABLE public.mw_watch_item
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'makerworld',
  ADD COLUMN IF NOT EXISTS verdict  JSONB;

-- troca a unicidade (org, kind, external_id) → (org, platform, kind, external_id)
ALTER TABLE public.mw_watch_item
  DROP CONSTRAINT IF EXISTS mw_watch_item_organization_id_kind_external_id_key;
ALTER TABLE public.mw_watch_item
  ADD CONSTRAINT mw_watch_item_org_platform_kind_extid_key
  UNIQUE (organization_id, platform, kind, external_id);
