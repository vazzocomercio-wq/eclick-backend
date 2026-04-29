-- Sprint ROADMAP — tabelas pra /dashboard/roadmap
--
-- Duas tabelas: roadmap_phases (8 fases macro) e roadmap_items (cards
-- dentro de cada fase). Org-scoped, RLS habilitada com policy via
-- organization_members. Status whitelist enforced via CHECK.
--
-- Rollback:
--   DROP TABLE IF EXISTS roadmap_items;
--   DROP TABLE IF EXISTS roadmap_phases;

BEGIN;

-- ── 1. roadmap_phases ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap_phases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  num             text NOT NULL,                  -- 'F1', 'F2', ...
  label           text NOT NULL,
  sub             text,
  status          text NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('done','wip','next','new','planned')),
  pct             integer NOT NULL DEFAULT 0 CHECK (pct BETWEEN 0 AND 100),
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Idempotência do seed: 1 fase por (org, num).
CREATE UNIQUE INDEX IF NOT EXISTS roadmap_phases_org_num_unique
  ON roadmap_phases (organization_id, num);

-- ── 2. roadmap_items ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phase_id        uuid NOT NULL REFERENCES roadmap_phases(id) ON DELETE CASCADE,
  label           text NOT NULL,
  status          text NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('done','wip','next','new','planned')),
  priority        integer NOT NULL DEFAULT 0,     -- 0=normal, 1=alta, 2=urgente
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Acelera GET /roadmap (que pega items por phase + ordena por status/created)
CREATE INDEX IF NOT EXISTS roadmap_items_phase_idx
  ON roadmap_items (phase_id, status, created_at);

-- ── 3. RLS ───────────────────────────────────────────────────────────────
ALTER TABLE roadmap_phases ENABLE ROW LEVEL SECURITY;
ALTER TABLE roadmap_items  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members roadmap_phases" ON roadmap_phases;
CREATE POLICY "org members roadmap_phases"
  ON roadmap_phases FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "org members roadmap_items" ON roadmap_items;
CREATE POLICY "org members roadmap_items"
  ON roadmap_items FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

GRANT ALL ON roadmap_phases TO service_role;
GRANT ALL ON roadmap_items  TO service_role;

COMMIT;
