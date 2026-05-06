-- ============================================================
-- Onda 4 / A2 — Vitrine Personalizada
--   storefront_rules: regras condicionais por contexto
--   product_collections: coleções de produtos
-- ============================================================

CREATE TABLE IF NOT EXISTS storefront_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name        TEXT NOT NULL,
  description TEXT,
  priority    INTEGER NOT NULL DEFAULT 0,

  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions    JSONB NOT NULL DEFAULT '[]'::jsonb,

  enabled BOOLEAN NOT NULL DEFAULT true,

  impressions    INTEGER NOT NULL DEFAULT 0,
  conversions    INTEGER NOT NULL DEFAULT 0,
  conversion_rate NUMERIC NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_storefront_rules_org     ON storefront_rules(organization_id);
CREATE INDEX IF NOT EXISTS idx_storefront_rules_enabled ON storefront_rules(organization_id, enabled, priority)
  WHERE enabled = true;

-- Coleções de produtos
CREATE TABLE IF NOT EXISTS product_collections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  description     TEXT,
  cover_image_url TEXT,

  collection_type TEXT NOT NULL DEFAULT 'manual'
    CHECK (collection_type IN ('manual','ai_generated','rule_based','seasonal')),

  product_ids   UUID[] NOT NULL DEFAULT '{}'::uuid[],
  filter_rules  JSONB  NOT NULL DEFAULT '{}'::jsonb,

  sort_order TEXT NOT NULL DEFAULT 'ai_score_desc'
    CHECK (sort_order IN ('ai_score_desc','price_asc','price_desc','newest','best_selling','manual')),
  max_products INTEGER NOT NULL DEFAULT 20,

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','active','scheduled','expired','archived')),
  active_from  TIMESTAMPTZ,
  active_until TIMESTAMPTZ,

  landing_page_enabled BOOLEAN NOT NULL DEFAULT false,
  landing_page_data    JSONB   NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_slug   ON product_collections(organization_id, slug);
CREATE INDEX IF NOT EXISTS        idx_collections_org    ON product_collections(organization_id);
CREATE INDEX IF NOT EXISTS        idx_collections_status ON product_collections(status);

CREATE OR REPLACE FUNCTION public.set_storefront_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_storefront_rules_updated ON storefront_rules;
CREATE TRIGGER trg_storefront_rules_updated BEFORE UPDATE ON storefront_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_storefront_updated_at();

DROP TRIGGER IF EXISTS trg_collections_updated ON product_collections;
CREATE TRIGGER trg_collections_updated BEFORE UPDATE ON product_collections
  FOR EACH ROW EXECUTE FUNCTION public.set_storefront_updated_at();

ALTER TABLE storefront_rules     ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_collections  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS storefront_rules_select ON storefront_rules;
CREATE POLICY storefront_rules_select ON storefront_rules FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS storefront_rules_modify ON storefront_rules;
CREATE POLICY storefront_rules_modify ON storefront_rules FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS collections_select ON product_collections;
CREATE POLICY collections_select ON product_collections FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS collections_modify ON product_collections;
CREATE POLICY collections_modify ON product_collections FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
