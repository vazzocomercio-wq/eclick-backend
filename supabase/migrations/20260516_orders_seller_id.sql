-- Multi-conta ML: adiciona seller_id em orders pra filtrar/agregar por
-- conta direto no DB (antes a coluna nao existia, dependia de chamar
-- ML em runtime).
--
-- Backfill: ate 2026-05-06 ~19:22 a Vazzo so tinha 1 conta conectada
-- (VAZZO_ seller 2290161131). Todos pedidos pre-existentes vem dela.
-- Pedidos novos virao com seller_id setado pela ingestao (apos deploy
-- desta sprint).
--
-- Rollback:
--   ALTER TABLE orders DROP COLUMN IF EXISTS seller_id;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS seller_id bigint;

-- Index composto pra queries da listagem (org + seller + date desc)
CREATE INDEX IF NOT EXISTS idx_orders_org_seller_sold_at
  ON orders(organization_id, seller_id, sold_at DESC);

-- Index simples pra agregacoes por seller
CREATE INDEX IF NOT EXISTS idx_orders_seller_id
  ON orders(seller_id) WHERE seller_id IS NOT NULL;

-- Backfill historico Vazzo: tudo que ja existe = VAZZO_ (2290161131).
-- Pedidos sem seller_id de outras orgs ficam NULL (cada org backfill
-- com seu seller principal num passo futuro se precisar).
UPDATE orders
   SET seller_id = 2290161131
 WHERE seller_id IS NULL
   AND organization_id = '4ef1aabd-c209-40b0-b034-ef69dcb66833';
