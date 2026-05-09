-- Adiciona breakdown detalhado do frete em orders pra UI mostrar:
-- - Frete pago pelo comprador (shipping_buyer_paid)
-- - Reembolso do ML (shipping_ml_refund)
-- - Frete bruto (shipping_gross — valor cheio antes de descontos)
-- shipping_cost continua sendo o LIQUIDO pago pelo vendedor.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS shipping_buyer_paid numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shipping_ml_refund  numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shipping_gross      numeric DEFAULT 0;
