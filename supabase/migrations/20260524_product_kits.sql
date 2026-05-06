-- ============================================================
-- Onda 4 / A5 — Kits & Combos IA
-- ============================================================
CREATE TABLE IF NOT EXISTS product_kits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name            TEXT NOT NULL,
  slug            TEXT,
  description     TEXT,
  cover_image_url TEXT,

  kit_type TEXT NOT NULL CHECK (kit_type IN (
    'kit','combo','cross_sell','upsell','buy_together',
    'by_room','by_occasion','clearance'
  )),

  -- [{ product_id, quantity, role }]
  items JSONB NOT NULL DEFAULT '[]'::jsonb,

  original_total NUMERIC NOT NULL,
  kit_price      NUMERIC NOT NULL,
  discount_pct   NUMERIC,
  savings_amount NUMERIC,
  margin_pct     NUMERIC,

  ai_generated   BOOLEAN NOT NULL DEFAULT false,
  ai_reasoning   TEXT,
  ai_confidence  NUMERIC,
  generation_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN (
    'suggested','approved','active','paused','archived'
  )),

  views   INTEGER NOT NULL DEFAULT 0,
  sales   INTEGER NOT NULL DEFAULT 0,
  revenue NUMERIC NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kits_org    ON product_kits(organization_id);
CREATE INDEX IF NOT EXISTS idx_kits_type   ON product_kits(kit_type);
CREATE INDEX IF NOT EXISTS idx_kits_status ON product_kits(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kits_slug ON product_kits(organization_id, slug)
  WHERE slug IS NOT NULL;

CREATE OR REPLACE FUNCTION public.set_kits_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kits_updated ON product_kits;
CREATE TRIGGER trg_kits_updated BEFORE UPDATE ON product_kits
  FOR EACH ROW EXECUTE FUNCTION public.set_kits_updated_at();

ALTER TABLE product_kits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kits_select ON product_kits;
CREATE POLICY kits_select ON product_kits FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS kits_modify ON product_kits;
CREATE POLICY kits_modify ON product_kits FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
