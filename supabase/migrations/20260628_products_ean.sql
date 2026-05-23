-- F12 Fulfillment — código de barras (EAN/GTIN) no catálogo.
--
-- A bipagem na separação aceita SKU, EAN ou QR code. `products` não tinha
-- onde guardar o código de barras, então adicionamos `ean` (aditivo,
-- nullable). O seed do fulfillment copia products.ean → pick_tasks.expected_barcode
-- e o scan casa contra SKU OU EAN. O lojista preenche o EAN ao longo do tempo.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS ean text;

CREATE INDEX IF NOT EXISTS idx_products_ean
  ON public.products(organization_id, ean) WHERE ean IS NOT NULL;

COMMENT ON COLUMN public.products.ean IS
  'Código de barras (EAN/GTIN) do produto. Usado na bipagem da separação (F12 Fulfillment).';
