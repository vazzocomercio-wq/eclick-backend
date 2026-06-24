-- ============================================================
-- Product OS — cadastro completo de insumo + custo médio ponderado (WAC)
-- cost_per_unit passa a ser o CUSTO MÉDIO, recalculado a cada entrada.
-- Aditivo: colunas novas em production_input e production_input_movement.
-- ============================================================
ALTER TABLE production_input
  ADD COLUMN IF NOT EXISTS sku           TEXT,
  ADD COLUMN IF NOT EXISTS description   TEXT,
  ADD COLUMN IF NOT EXISTS brand         TEXT,
  ADD COLUMN IF NOT EXISTS supplier      TEXT,
  ADD COLUMN IF NOT EXISTS diameter_mm   NUMERIC,
  ADD COLUMN IF NOT EXISTS spool_weight_g NUMERIC,
  ADD COLUMN IF NOT EXISTS color_hex     TEXT,
  ADD COLUMN IF NOT EXISTS notes         TEXT;
CREATE INDEX IF NOT EXISTS idx_pinput_sku ON production_input(organization_id, sku) WHERE sku IS NOT NULL;

-- custo da entrada (pra trilha do médio ponderado)
ALTER TABLE production_input_movement
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC;
