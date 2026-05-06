-- Onda 1 / Movimento 2 (sprint 1) — Enriquecimento AI do Catálogo
--
-- Adiciona 15 colunas em `products` + 1 coluna em `ai_usage_log` pra
-- rastreio de custo. Score composto (0-100) calculado backend-side
-- baseado em 10 componentes (qualidade de fotos, descrição, dimensões, etc).
--
-- Sprint 1 (esta migration): campos + endpoint manual de enriquecimento.
-- Sprint 2 (futura M2.2): worker automático que detecta pending=true e
-- enriquece em background.
--
-- Rollback:
--   ALTER TABLE products DROP COLUMN IF EXISTS ai_short_description;
--   ALTER TABLE products DROP COLUMN IF EXISTS ai_long_description;
--   ALTER TABLE products DROP COLUMN IF EXISTS ai_keywords;
--   ALTER TABLE products DROP COLUMN IF EXISTS ai_target_audience;
--   ALTER TABLE products DROP COLUMN IF EXISTS ai_use_cases;
--   ALTER TABLE products DROP COLUMN IF EXISTS ai_pros;
--   ALTER TABLE products DROP COLUMN IF EXISTS ai_cons;
--   ALTER TABLE products DROP COLUMN IF EXISTS ai_seo_keywords;
--   ALTER TABLE products DROP COLUMN IF EXISTS ai_seasonality_hint;
--   ALTER TABLE products DROP COLUMN IF EXISTS ai_score;
--   ALTER TABLE products DROP COLUMN IF EXISTS ai_score_breakdown;
--   ALTER TABLE products DROP COLUMN IF EXISTS ai_enriched_at;
--   ALTER TABLE products DROP COLUMN IF EXISTS ai_enrichment_version;
--   ALTER TABLE products DROP COLUMN IF EXISTS ai_enrichment_cost_usd;
--   ALTER TABLE products DROP COLUMN IF EXISTS ai_enrichment_pending;
--   ALTER TABLE ai_usage_log DROP COLUMN IF EXISTS catalog_product_id;

-- ── 1. products: 15 colunas de enriquecimento ────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS ai_short_description     text,
  ADD COLUMN IF NOT EXISTS ai_long_description      text,
  ADD COLUMN IF NOT EXISTS ai_keywords              text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ai_target_audience       text,
  ADD COLUMN IF NOT EXISTS ai_use_cases             text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ai_pros                  text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ai_cons                  text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ai_seo_keywords          text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ai_seasonality_hint      text,
  ADD COLUMN IF NOT EXISTS ai_score                 integer CHECK (ai_score IS NULL OR ai_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS ai_score_breakdown       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS ai_enriched_at           timestamptz,
  ADD COLUMN IF NOT EXISTS ai_enrichment_version    text,
  ADD COLUMN IF NOT EXISTS ai_enrichment_cost_usd   numeric(10,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_enrichment_pending    boolean NOT NULL DEFAULT false;

-- Index pra worker M2.2 pegar pendentes rapidamente
CREATE INDEX IF NOT EXISTS idx_products_ai_enrichment_pending
  ON products(organization_id, ai_enriched_at NULLS FIRST)
  WHERE ai_enrichment_pending = true;

-- Index pra dashboard de score (L3)
CREATE INDEX IF NOT EXISTS idx_products_ai_score
  ON products(organization_id, ai_score DESC NULLS LAST)
  WHERE ai_score IS NOT NULL;

-- ── 2. ai_usage_log: catalog_product_id pra rastreio de custo ────────────
ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS catalog_product_id uuid
    REFERENCES products(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ai_usage_log_catalog_product_idx
  ON ai_usage_log(catalog_product_id, created_at DESC)
  WHERE catalog_product_id IS NOT NULL;
