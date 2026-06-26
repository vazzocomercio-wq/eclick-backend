-- ============================================================
-- Product OS — dimensões (footprint) da peça, p/ o plano de pratos
--
-- Bounding box da peça na mesa (largura×profundidade×altura em mm). Alimenta
-- o cálculo de "quantas peças cabem num prato" (#2 agrupamento). Pode vir do
-- briefing (módulos têm params), do slicer ou ser digitado. 100% aditivo.
-- ============================================================
ALTER TABLE product_dev_part ADD COLUMN IF NOT EXISTS width_mm  NUMERIC;
ALTER TABLE product_dev_part ADD COLUMN IF NOT EXISTS depth_mm  NUMERIC;
ALTER TABLE product_dev_part ADD COLUMN IF NOT EXISTS height_mm NUMERIC;
