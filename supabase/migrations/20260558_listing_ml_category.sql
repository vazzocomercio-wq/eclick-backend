-- ============================================
-- F6 Sprint 3.5 — Categoria ML real no listing
-- Adiciona 2 colunas pra rastrear o que o predict_category do ML retorna
-- - category_ml_id: ID real (MLB189195, MLB1586, etc) — usado pra publicar
-- - attributes_ml_suggested: lista de attributes sugeridos pela predict
--   (formato: [{ id, name, value_id?, value_name? }])
-- ============================================

ALTER TABLE public.creative_listings
  ADD COLUMN IF NOT EXISTS category_ml_id text,
  ADD COLUMN IF NOT EXISTS attributes_ml_suggested jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Index pra filtrar listings por categoria (queries futuras de quality/analytics)
CREATE INDEX IF NOT EXISTS ix_listings_category_ml
  ON public.creative_listings (category_ml_id)
  WHERE category_ml_id IS NOT NULL;

COMMENT ON COLUMN public.creative_listings.category_ml_id IS
  'Categoria ML real (MLB...) sugerida pelo predict_category. Usada no publish.';
COMMENT ON COLUMN public.creative_listings.attributes_ml_suggested IS
  'Attributes sugeridos pelo predict_category — base pra montar ficha técnica ML-compatible.';
