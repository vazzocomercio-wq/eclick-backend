-- ============================================================
-- Product OS — Impressão multicor (2+ filamentos na mesma peça)
--
-- A versão guarda a lista de filamentos do .3mf (cor/material/peso por cor).
-- A OP guarda o "mapa" de qual ROLO foi escolhido pra cada cor (índice do
-- filamento → insumo), pra reservar/custear/mapear o AMS de cada um.
-- 100% aditivo: peça de 1 cor fica com 1 item (ou null = fluxo antigo).
-- ============================================================

-- [{index, material, color, weight_g}]
ALTER TABLE product_dev_version ADD COLUMN IF NOT EXISTS filaments JSONB;
-- [{index, input_id, weight_g}]  (rolo escolhido por cor, na criação da OP)
ALTER TABLE production_order   ADD COLUMN IF NOT EXISTS filament_map JSONB;
