-- ============================================================
-- Product OS — crédito de estoque POR COR na produção
--
-- A OP guarda QUAL variante de cor está produzindo (sku_variant_id). Quando o
-- produto é variável (products.has_variations), a conclusão credita o estoque
-- DAQUELA cor na variação certa (match por sku = base-cor) e recomputa o
-- products.stock como a soma das cores. 100% aditivo (null = comportamento antigo).
-- ============================================================
ALTER TABLE production_order
  ADD COLUMN IF NOT EXISTS sku_variant_id UUID REFERENCES product_dev_sku_variant(id) ON DELETE SET NULL;
