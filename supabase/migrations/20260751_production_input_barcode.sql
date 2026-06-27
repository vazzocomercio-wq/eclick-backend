-- ============================================================
-- Product OS — código de barras no insumo (localizar por scan/SKU/barras)
-- 100% aditivo. `sku` já existe; adiciona `barcode` p/ leitura/escaneamento.
-- ============================================================
ALTER TABLE production_input ADD COLUMN IF NOT EXISTS barcode TEXT;
CREATE INDEX IF NOT EXISTS idx_pinput_barcode ON production_input(organization_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pinput_sku     ON production_input(organization_id, sku) WHERE sku IS NOT NULL;
