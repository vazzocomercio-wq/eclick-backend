-- Onda 1 / Movimento 1 — Ponte Creative → Products
--
-- Liga `creative_products` (silo do módulo IA Criativo) à `products` (catálogo
-- mestre). FK opcional pois um criativo pode existir sem produto no catálogo
-- (cenário B do spec — usuário cria a partir de imagem só).
--
-- Mesma lógica em `creative_listings.product_catalog_id` — permite que um
-- listing aprovado seja amarrado direto ao produto do catálogo, mesmo se o
-- creative_product foi vinculado depois.
--
-- View v_product_creative_summary agrega catálogo + criativos pra UI mostrar
-- "produto X tem N criativos, M listings, K imagens aprovadas" sem 4 queries.
--
-- Rollback:
--   DROP VIEW IF EXISTS v_product_creative_summary;
--   ALTER TABLE creative_listings DROP COLUMN IF EXISTS product_catalog_id;
--   ALTER TABLE creative_products DROP COLUMN IF EXISTS product_id;

-- 1. FK creative_products.product_id → products.id (nullable, ON DELETE SET NULL)
ALTER TABLE creative_products
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_creative_products_product_id
  ON creative_products(product_id)
  WHERE product_id IS NOT NULL;

-- 2. FK creative_listings.product_catalog_id → products.id (nullable)
ALTER TABLE creative_listings
  ADD COLUMN IF NOT EXISTS product_catalog_id uuid REFERENCES products(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_creative_listings_product_catalog
  ON creative_listings(product_catalog_id)
  WHERE product_catalog_id IS NOT NULL;

-- 3. View resumo catálogo + criativos.
--    LEFT JOINs preservam produtos sem criativos (count = 0).
--    COUNT(DISTINCT) lida com explosão Cartesiana das múltiplas joins.
CREATE OR REPLACE VIEW v_product_creative_summary AS
SELECT
  p.id              AS product_id,
  p.name,
  p.sku,
  p.brand,
  p.category,
  p.status          AS catalog_status,
  p.organization_id,
  COUNT(DISTINCT cp.id) AS creative_count,
  COUNT(DISTINCT cl.id) AS listing_count,
  COUNT(DISTINCT ci.id) FILTER (WHERE ci.status = 'approved') AS approved_images_count,
  MAX(cp.created_at)    AS last_creative_at,
  BOOL_OR(cl.status = 'approved') AS has_approved_listing
FROM products p
LEFT JOIN creative_products      cp  ON cp.product_id = p.id
LEFT JOIN creative_listings      cl  ON cl.product_catalog_id = p.id
LEFT JOIN creative_image_jobs    cij ON cij.product_id = cp.id
LEFT JOIN creative_images        ci  ON ci.job_id = cij.id
GROUP BY p.id;

-- View herda RLS das tabelas base (products já tem). Service role bypassa.
GRANT SELECT ON v_product_creative_summary TO authenticated;
GRANT SELECT ON v_product_creative_summary TO service_role;
