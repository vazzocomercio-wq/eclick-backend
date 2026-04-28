-- Bulk action "Marcar problema" em /pedidos DataTable view (Sprint B bloco 3).
-- has_problem        = flag binária pro filtro
-- problem_note       = texto livre do motivo
-- problem_severity   = nível com CHECK constraint (low | medium | high | critical)
-- Index parcial pra queries "WHERE has_problem = true" rápidas.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS has_problem      BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS problem_note     TEXT,
  ADD COLUMN IF NOT EXISTS problem_severity TEXT
    CHECK (problem_severity IN ('low','medium','high','critical'));

CREATE INDEX IF NOT EXISTS idx_orders_has_problem
  ON orders(has_problem) WHERE has_problem = true;
