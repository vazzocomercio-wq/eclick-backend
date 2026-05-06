-- Onda 1 hybrid C — Delta 1
-- catalog_status (state machine derivado) + channel_titles/descriptions
--
-- catalog_status:
--   'incomplete' — falta name/photos/price (não publicável)
--   'draft'      — completo mas sem enriquecimento
--   'enriching'  — worker processando ai_enrichment_pending=true
--   'enriched'   — IA enriqueceu (aguarda revisão/publicação)
--   'ready'      — enriquecido + todos campos críticos pra ML (gtin/categoria_ml/dims)
--   'published'  — em pelo menos 1 canal (ml_item_id OU landing_published)
--   'paused'     — user pausou explicitamente (sticky)
--
-- Trigger BEFORE INSERT OR UPDATE deriva o status automaticamente.
-- Único state explícito do user: 'paused' — preserva quando UPDATE não muda
-- nenhum campo factual. App pode setar 'paused' direto, trigger respeita.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS catalog_status text NOT NULL DEFAULT 'incomplete'
    CHECK (catalog_status IN (
      'incomplete', 'draft', 'enriching', 'enriched', 'ready', 'published', 'paused'
    )),
  ADD COLUMN IF NOT EXISTS channel_titles       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS channel_descriptions jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_products_catalog_status
  ON products(organization_id, catalog_status);

-- Função de derivação
CREATE OR REPLACE FUNCTION derive_catalog_status(p products) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  -- Em INSERT, paused não pode ser inicial. Em UPDATE, sticky se já era paused.
  -- A trigger lida com esse sticky abaixo. Aqui só faz derivação factual.
  IF p.ai_enrichment_pending = true THEN
    RETURN 'enriching';
  END IF;
  IF p.ml_item_id IS NOT NULL OR p.landing_published = true THEN
    RETURN 'published';
  END IF;
  IF p.ai_enriched_at IS NOT NULL THEN
    -- Considera 'ready' se tem todos campos críticos pra publicar no ML
    IF p.name IS NOT NULL AND p.brand IS NOT NULL
       AND p.gtin IS NOT NULL AND p.category_ml_id IS NOT NULL
       AND p.weight_kg IS NOT NULL AND p.width_cm IS NOT NULL
       AND p.length_cm IS NOT NULL AND p.height_cm IS NOT NULL
       AND p.price IS NOT NULL AND p.price > 0 THEN
      RETURN 'ready';
    END IF;
    RETURN 'enriched';
  END IF;
  IF p.name IS NULL OR length(coalesce(p.name, '')) < 5
     OR COALESCE(array_length(p.photo_urls, 1), 0) < 1
     OR p.price IS NULL OR p.price <= 0 THEN
    RETURN 'incomplete';
  END IF;
  RETURN 'draft';
END;
$$;

-- Trigger
CREATE OR REPLACE FUNCTION trg_compute_catalog_status() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  derived text;
BEGIN
  derived := derive_catalog_status(NEW);

  -- Sticky 'paused': se já estava paused, mantém — A NÃO SER que o user
  -- explicitamente mude pra outro valor (NEW.catalog_status != OLD.catalog_status)
  IF TG_OP = 'UPDATE' AND OLD.catalog_status = 'paused' THEN
    IF NEW.catalog_status IS NOT DISTINCT FROM OLD.catalog_status THEN
      -- App não mexeu, fica paused
      NEW.catalog_status := 'paused';
      RETURN NEW;
    END IF;
    -- App mudou explicitamente pra outro valor — respeita
    RETURN NEW;
  END IF;

  -- Caso normal: deriva
  -- Se app explicitamente setou 'paused', respeita
  IF NEW.catalog_status = 'paused' AND TG_OP = 'UPDATE'
     AND OLD.catalog_status IS DISTINCT FROM NEW.catalog_status THEN
    RETURN NEW;
  END IF;

  NEW.catalog_status := derived;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_catalog_status ON products;
CREATE TRIGGER trg_products_catalog_status
BEFORE INSERT OR UPDATE ON products
FOR EACH ROW
EXECUTE FUNCTION trg_compute_catalog_status();

-- Backfill: força derivação em todas as rows existentes
-- Trick: UPDATE no_op pra disparar trigger
UPDATE products SET updated_at = updated_at WHERE catalog_status = 'incomplete';
