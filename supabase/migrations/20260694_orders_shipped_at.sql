-- Data REAL de postagem do pedido (saiu da mão do seller), capturada do
-- shipment do Mercado Livre (status_history.date_shipped). Espelhada em coluna
-- top-level pelo mesmo padrão de `shipping_status`, pra:
--  - o funil dropship carimbar `dropship_order_identifications.shipped_at` com
--    a data de expedição REAL (não a hora do cron) → coorte da OC precisa
--  - radares/relatórios consultarem postagem sem cavar no raw_data
--
-- Aditiva e inerte pro que já existe (coluna nullable). Idempotente.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_orders_shipped_at
  ON orders (shipped_at)
  WHERE shipped_at IS NOT NULL;
