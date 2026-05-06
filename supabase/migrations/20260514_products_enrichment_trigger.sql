-- Onda 1 / M2 sprint 2 — Trigger automático de enriquecimento.
--
-- Marca ai_enrichment_pending=true quando campos chave do produto mudam.
-- Worker pega pendentes a cada 5min (max 5/tick → ~$3/hora teto absoluto).
--
-- Anti-loop: a trigger SÓ checa mudança em campos do produto (name,
-- description, brand, category, photo_urls). Quando o enrichService faz
-- update setando ai_*, esses campos não mudam → trigger não dispara →
-- sem loop infinito.
--
-- Catch-up de produtos pré-existentes (sem ai_enriched_at): NÃO é
-- automático nesta migration. Use L1 (enriquecimento em massa) pra
-- ativar produtos antigos manualmente.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_mark_product_enrichment_pending ON products;
--   DROP FUNCTION IF EXISTS mark_product_enrichment_pending();

CREATE OR REPLACE FUNCTION mark_product_enrichment_pending()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Em INSERT, sempre marca pending. Worker enriquece na próxima passada.
  IF TG_OP = 'INSERT' THEN
    NEW.ai_enrichment_pending := COALESCE(NEW.ai_enrichment_pending, true);
    RETURN NEW;
  END IF;

  -- Em UPDATE, só marca se algum campo "do produto" mudou.
  -- Isso protege contra loop quando o enrichService grava ai_*.
  IF TG_OP = 'UPDATE' THEN
    IF (
      OLD.name        IS DISTINCT FROM NEW.name        OR
      OLD.description IS DISTINCT FROM NEW.description OR
      OLD.brand       IS DISTINCT FROM NEW.brand       OR
      OLD.category    IS DISTINCT FROM NEW.category    OR
      OLD.photo_urls  IS DISTINCT FROM NEW.photo_urls
    ) THEN
      NEW.ai_enrichment_pending := true;
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mark_product_enrichment_pending ON products;
CREATE TRIGGER trg_mark_product_enrichment_pending
BEFORE INSERT OR UPDATE ON products
FOR EACH ROW
EXECUTE FUNCTION mark_product_enrichment_pending();
