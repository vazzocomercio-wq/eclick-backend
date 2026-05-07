-- ============================================================
-- F7 Quality Center IA — Camada 1 (Diagnostico)
-- ============================================================
--
-- Adaptacao da spec original:
-- - Endpoint /items/{id}/performance NAO existe no ML API. Fonte
--   primaria muda pra /catalog_quality/status (1 call por seller
--   retorna tudo). Score/level computados por nos.
-- - Multi-conta: TODAS tabelas com seller_id BIGINT desde ja.
-- - Removidos buckets/variables/rules (eram especificos do
--   endpoint /performance). Adicionados pi/ft/all completion
--   booleans + counts pra query rapida.
--
-- Rollback:
--   DROP TABLE ml_quality_sync_logs;
--   DROP TABLE ml_quality_org_summary;
--   DROP TABLE ml_category_attributes;
--   DROP TABLE ml_quality_snapshots;
--   ALTER TABLE products DROP COLUMN IF EXISTS ml_user_product_id;

-- ─── 1. products: nova coluna ml_user_product_id ─────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS ml_user_product_id text;

CREATE INDEX IF NOT EXISTS idx_products_ml_user_product
  ON products(ml_user_product_id) WHERE ml_user_product_id IS NOT NULL;

-- ─── 2. ml_quality_snapshots ─────────────────────────────────
-- 1 snapshot por (org, seller_id, ml_item_id, fetched_at).
-- Sync substitui (UPSERT por chave logica) pra evitar bloat —
-- mantemos historico em ml_quality_sync_logs.
CREATE TABLE IF NOT EXISTS ml_quality_snapshots (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id                   bigint NOT NULL,
  product_id                  uuid REFERENCES products(id) ON DELETE SET NULL,
  ml_item_id                  text NOT NULL,
  ml_user_product_id          text,
  ml_domain_id                text,

  -- Score derivado (nao vem do ML — calculamos baseado em filled/total)
  ml_score                    integer CHECK (ml_score IS NULL OR (ml_score BETWEEN 0 AND 100)),
  ml_level                    text CHECK (ml_level IN ('basic', 'satisfactory', 'professional') OR ml_level IS NULL),

  -- Adoption status do /catalog_quality/status (3 dimensoes)
  pi_complete                 boolean DEFAULT false,
  pi_filled_count             integer DEFAULT 0,
  pi_missing_count            integer DEFAULT 0,
  pi_missing_attributes       text[] DEFAULT '{}',

  ft_complete                 boolean DEFAULT false,
  ft_filled_count             integer DEFAULT 0,
  ft_missing_count            integer DEFAULT 0,
  ft_missing_attributes       text[] DEFAULT '{}',

  all_complete                boolean DEFAULT false,
  all_filled_count            integer DEFAULT 0,
  all_missing_count           integer DEFAULT 0,
  all_missing_attributes      text[] DEFAULT '{}',

  -- Tags importantes (de /users/{id}/items/search?tags=X)
  ml_tags                     text[] DEFAULT '{}',

  -- Bloqueios e penalizacoes
  has_exposure_penalty        boolean DEFAULT false,
  penalty_reasons             text[] DEFAULT '{}',

  -- Pending actions (derivado das tags + missing attrs)
  pending_actions             jsonb DEFAULT '[]'::jsonb,
  pending_count               integer DEFAULT 0,

  -- Analise interna combinada (Camada 2/4)
  internal_priority_score     numeric,
  fix_complexity              text CHECK (fix_complexity IN ('easy', 'medium', 'hard', 'blocked') OR fix_complexity IS NULL),
  estimated_score_after_fix   integer,

  -- Raw shape de /catalog_quality (item-level) pra debug
  raw_adoption_status         jsonb DEFAULT '{}'::jsonb,

  fetched_at                  timestamptz NOT NULL DEFAULT now(),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_id, seller_id, ml_item_id)
);

-- Indexes (compostos com seller_id pra multi-conta)
CREATE INDEX IF NOT EXISTS idx_mlq_snap_org_seller
  ON ml_quality_snapshots(organization_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_mlq_snap_product
  ON ml_quality_snapshots(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mlq_snap_score
  ON ml_quality_snapshots(organization_id, seller_id, ml_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_mlq_snap_level
  ON ml_quality_snapshots(organization_id, seller_id, ml_level);
CREATE INDEX IF NOT EXISTS idx_mlq_snap_priority
  ON ml_quality_snapshots(organization_id, seller_id, internal_priority_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_mlq_snap_penalty
  ON ml_quality_snapshots(organization_id, seller_id) WHERE has_exposure_penalty = true;
CREATE INDEX IF NOT EXISTS idx_mlq_snap_domain
  ON ml_quality_snapshots(organization_id, seller_id, ml_domain_id);
CREATE INDEX IF NOT EXISTS idx_mlq_snap_quick_wins
  ON ml_quality_snapshots(organization_id, seller_id, ml_score) WHERE ml_score >= 85 AND ml_score < 100;

-- ─── 3. ml_category_attributes (cache 7d) ────────────────────
CREATE TABLE IF NOT EXISTS ml_category_attributes (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ml_category_id              text NOT NULL UNIQUE,
  ml_domain_id                text,
  attributes                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_attributes            integer,
  required_attributes         integer,
  required_for_catalog        integer,
  last_fetched_at             timestamptz NOT NULL DEFAULT now(),
  expires_at                  timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_cat_attrs_domain
  ON ml_category_attributes(ml_domain_id);
CREATE INDEX IF NOT EXISTS idx_ml_cat_attrs_expires
  ON ml_category_attributes(expires_at);

-- ─── 4. ml_quality_org_summary (1 row por org+seller) ────────
CREATE TABLE IF NOT EXISTS ml_quality_org_summary (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id                   bigint NOT NULL,

  total_items                 integer DEFAULT 0,
  items_basic                 integer DEFAULT 0,
  items_satisfactory          integer DEFAULT 0,
  items_professional          integer DEFAULT 0,
  items_complete              integer DEFAULT 0,
  items_incomplete            integer DEFAULT 0,
  items_with_penalty          integer DEFAULT 0,

  avg_score                   numeric,
  median_score                numeric,
  total_pending_actions       integer DEFAULT 0,

  -- Top 10 dominios criticos (por items_incomplete desc)
  top_critical_domains        jsonb DEFAULT '[]'::jsonb,
  -- [{ "domain_id": "...", "items_incomplete": 45, "avg_score": 62 }]

  -- Top atributos mais ausentes
  top_missing_attributes      jsonb DEFAULT '[]'::jsonb,
  -- [{ "attribute": "MATERIAL", "missing_in_items": 234, "domain_id": "..." }]

  quick_wins_count            integer DEFAULT 0,
  quick_wins_estimated_gain   integer DEFAULT 0,

  last_sync_at                timestamptz,
  next_sync_at                timestamptz,

  updated_at                  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_id, seller_id)
);

CREATE INDEX IF NOT EXISTS idx_mlq_summary_org
  ON ml_quality_org_summary(organization_id);

-- ─── 5. ml_quality_sync_logs (auditoria de syncs) ────────────
CREATE TABLE IF NOT EXISTS ml_quality_sync_logs (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id                   bigint,                   -- null = fan-out (todas contas)

  sync_type                   text NOT NULL CHECK (sync_type IN (
    'full',                                              -- catalog_quality + tags + cache attrs
    'catalog_quality',                                   -- so /catalog_quality/status
    'tags_search',                                       -- so /items/search?tags=X
    'category_attrs',                                    -- so /categories/{id}/attributes
    'single_item'                                        -- 1 item especifico
  )),

  items_processed             integer DEFAULT 0,
  items_updated               integer DEFAULT 0,
  items_failed                integer DEFAULT 0,
  api_calls_count             integer DEFAULT 0,

  status                      text NOT NULL DEFAULT 'running' CHECK (status IN (
    'running', 'completed', 'failed', 'partial'
  )),
  error_message               text,
  duration_seconds            integer,

  started_at                  timestamptz NOT NULL DEFAULT now(),
  completed_at                timestamptz
);

CREATE INDEX IF NOT EXISTS idx_mlq_sync_logs_org_seller
  ON ml_quality_sync_logs(organization_id, seller_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mlq_sync_logs_status
  ON ml_quality_sync_logs(status) WHERE status IN ('running', 'failed');

-- ─── 6. ml_quality_score_history (serie temporal por item) ──
-- INSERT-only quando score muda — habilita gráfico de evolução
-- por anúncio + métrica "quanto o catálogo melhorou esse mês".
-- Volume estimado: 1000 itens × 3 mudancas/mes = 36k rows/ano.
CREATE TABLE IF NOT EXISTS ml_quality_score_history (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id                   bigint NOT NULL,
  ml_item_id                  text NOT NULL,
  ml_score                    integer NOT NULL CHECK (ml_score BETWEEN 0 AND 100),
  ml_level                    text CHECK (ml_level IN ('basic', 'satisfactory', 'professional')),
  pi_complete                 boolean,
  ft_complete                 boolean,
  all_complete                boolean,
  captured_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mlq_history_item
  ON ml_quality_score_history(organization_id, seller_id, ml_item_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_mlq_history_org_period
  ON ml_quality_score_history(organization_id, seller_id, captured_at DESC);

-- ─── Trigger: auto-update updated_at ─────────────────────────
CREATE OR REPLACE FUNCTION ml_quality_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mlq_snap_updated ON ml_quality_snapshots;
CREATE TRIGGER trg_mlq_snap_updated
  BEFORE UPDATE ON ml_quality_snapshots
  FOR EACH ROW EXECUTE FUNCTION ml_quality_touch_updated_at();

DROP TRIGGER IF EXISTS trg_mlq_cat_attrs_updated ON ml_category_attributes;
CREATE TRIGGER trg_mlq_cat_attrs_updated
  BEFORE UPDATE ON ml_category_attributes
  FOR EACH ROW EXECUTE FUNCTION ml_quality_touch_updated_at();
