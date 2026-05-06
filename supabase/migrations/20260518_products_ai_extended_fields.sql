-- Onda 1 hybrid C — Delta extra
-- Campos faltantes da spec M2 original:
--   ai_analysis (Vision analysis)
--   differentials (USPs comerciais)
--   ai_suggested_* (campos pra user aplicar)
--   bullets / technical_sheet / faq / tags (campos "oficiais" do catálogo)
--   landing_page_data (jsonb pra futuro editor visual)

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS ai_analysis             jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS differentials           text[] NOT NULL DEFAULT '{}',
  -- Campos "sugeridos" pela IA — user aprova/aplica via POST /apply-suggestions
  ADD COLUMN IF NOT EXISTS ai_suggested_title      text,
  ADD COLUMN IF NOT EXISTS ai_suggested_bullets    text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ai_suggested_category   text,
  -- Campos "aplicados" / oficializados (depois do user aceitar sugestão)
  ADD COLUMN IF NOT EXISTS bullets                 text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS technical_sheet         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS faq                     jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS tags                    text[] NOT NULL DEFAULT '{}',
  -- Landing page customizada (sprint futura — editor visual)
  ADD COLUMN IF NOT EXISTS landing_page_data       jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_products_tags
  ON products USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_products_differentials
  ON products USING gin(differentials);
