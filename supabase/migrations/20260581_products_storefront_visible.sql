-- Loja Propria — Fase 9: "Enviar para a loja"
--
-- Coluna que marca quais produtos do catalogo aparecem na loja propria
-- (vitrine /loja/[slug]). Desacopla a vitrine do catalog_status (que e o
-- criterio de prontidao pro Mercado Livre) — o lojista escolhe explicitamente
-- o que vai pra loja. ADD COLUMN herda os grants da tabela.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS storefront_visible boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN products.storefront_visible IS
  'Loja Propria: true = produto publicado na vitrine /loja/[slug]. Independe de catalog_status.';

-- Indice parcial pra query da vitrine (organization_id + storefront_visible + stock).
CREATE INDEX IF NOT EXISTS idx_products_storefront
  ON products (organization_id)
  WHERE storefront_visible = true;
