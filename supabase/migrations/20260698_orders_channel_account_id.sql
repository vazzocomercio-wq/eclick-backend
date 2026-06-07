-- Identificador da CONTA/LOJA do canal no pedido, pra canais que não trazem a
-- conta na linha como o ML (que usa seller_id). Shopee/TikTok carimbam o
-- shop_id aqui na ingestão → o dropship distingue múltiplas lojas do mesmo
-- canal (multi-loja) ao casar com seller_account_suppliers.shopee_shop_id.
--
-- Aditiva, nullable, idempotente. ML continua usando seller_id; o identify usa
-- seller_id ?? channel_account_id.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS channel_account_id text;

CREATE INDEX IF NOT EXISTS idx_orders_channel_account_id
  ON orders (channel_account_id)
  WHERE channel_account_id IS NOT NULL;
