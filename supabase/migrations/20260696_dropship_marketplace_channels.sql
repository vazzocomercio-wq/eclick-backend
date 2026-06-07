-- Habilita TikTok Shop e Loja Própria (storefront) como canais de vínculo
-- conta→fornecedor no dropship. O CHECK original só aceitava
-- mercado_livre/shopee/amazon/magalu/others.
--
-- Loja única: TikTok/storefront não têm granularidade de conta via OAuth aqui,
-- então o vínculo é "conta-única" (sem id) e o identify resolve pelo único
-- parceiro ativo do canal. Multi-loja (shop_id no pedido) vem numa onda
-- seguinte. Idempotente.

ALTER TABLE seller_account_suppliers
  DROP CONSTRAINT IF EXISTS seller_account_suppliers_marketplace_check;

ALTER TABLE seller_account_suppliers
  ADD CONSTRAINT seller_account_suppliers_marketplace_check
  CHECK (marketplace IN (
    'mercado_livre', 'shopee', 'amazon', 'magalu',
    'tiktok_shop', 'storefront', 'others'
  ));
