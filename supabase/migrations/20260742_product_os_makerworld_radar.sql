-- ============================================================
-- Product OS — Radar de campeões do MakerWorld (Peça 3)
-- O feed "em alta" oficial é travado por login → v1 = WATCHLIST: o lojista
-- semeia modelos e o sistema fotografa as métricas (downloads/prints/likes/
-- coleções) ao longo do tempo via API by-id, rankeando por VELOCIDADE
-- (ganho por semana). Tabelas: item observado + série temporal de snapshots.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.mw_watch_item (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL DEFAULT 'design',          -- 'design' (v1; 'creator' futuro)
  external_id         TEXT NOT NULL,                           -- id do design no MakerWorld
  title               TEXT,
  cover_url           TEXT,
  creator             TEXT,
  license             TEXT,
  allow_recreation    BOOLEAN,
  source_url          TEXT,
  -- última leitura (espelho do snapshot mais recente, p/ leitura rápida)
  last_download_count   INTEGER NOT NULL DEFAULT 0,
  last_print_count      INTEGER NOT NULL DEFAULT 0,
  last_like_count       INTEGER NOT NULL DEFAULT 0,
  last_collection_count INTEGER NOT NULL DEFAULT 0,
  decision            TEXT NOT NULL DEFAULT 'observar',        -- observar | comprar | ignorar
  ai_suggestion       JSONB,                                   -- último copiloto IA (decisão+racional)
  notes               TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at     TIMESTAMPTZ,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, kind, external_id)
);
CREATE INDEX IF NOT EXISTS idx_mw_watch_item_org ON public.mw_watch_item (organization_id, is_active);

CREATE TABLE IF NOT EXISTS public.mw_watch_snapshot (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  watch_item_id    UUID NOT NULL REFERENCES public.mw_watch_item(id) ON DELETE CASCADE,
  download_count   INTEGER NOT NULL DEFAULT 0,
  print_count      INTEGER NOT NULL DEFAULT 0,
  like_count       INTEGER NOT NULL DEFAULT 0,
  collection_count INTEGER NOT NULL DEFAULT 0,
  captured_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mw_watch_snapshot_item ON public.mw_watch_snapshot (watch_item_id, captured_at);

-- ── RLS — membros da org ──────────────────────────────────────────
ALTER TABLE public.mw_watch_item     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mw_watch_snapshot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mw_watch_item_select ON public.mw_watch_item;
CREATE POLICY mw_watch_item_select ON public.mw_watch_item FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS mw_watch_item_modify ON public.mw_watch_item;
CREATE POLICY mw_watch_item_modify ON public.mw_watch_item FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS mw_watch_snapshot_select ON public.mw_watch_snapshot;
CREATE POLICY mw_watch_snapshot_select ON public.mw_watch_snapshot FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS mw_watch_snapshot_modify ON public.mw_watch_snapshot;
CREATE POLICY mw_watch_snapshot_modify ON public.mw_watch_snapshot FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

-- ── GRANTs — tabelas criadas via _admin_exec_sql não herdam os defaults ──
GRANT ALL ON TABLE public.mw_watch_item     TO service_role;
GRANT ALL ON TABLE public.mw_watch_snapshot TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mw_watch_item     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mw_watch_snapshot TO authenticated;
