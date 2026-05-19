-- Sessão 2026-05-19 (e-Click Saas 23) — Multi-conta: dono do anúncio.
--
-- product_listings.account_id (o seller_id da conta ML dona do anúncio)
-- estava nulo em ~325 vínculos. Sem ele, o sync de estoque empurrava com
-- o token de "uma conta qualquer" da org → 403 quando a conta não era a
-- dona. Backfill a partir de orders.seller_id (fonte confiável: um pedido
-- daquele anúncio carrega o seller dono).
--
-- O sync de estoque também passou a auto-preencher account_id quando
-- descobre a conta certa — esta migration só dá o pontapé inicial.

UPDATE public.product_listings pl
SET account_id = o.seller_id::text,
    updated_at = now()
FROM (
  SELECT DISTINCT marketplace_listing_id, seller_id
  FROM public.orders
  WHERE marketplace_listing_id IS NOT NULL
    AND seller_id IS NOT NULL
) o
WHERE pl.listing_id = o.marketplace_listing_id
  AND pl.platform   = 'mercadolivre'
  AND (pl.account_id IS NULL OR pl.account_id = '');
