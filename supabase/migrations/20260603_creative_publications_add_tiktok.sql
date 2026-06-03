-- Publicações cross-plataforma: o publish do Shopee e do TikTok Shop passam a
-- registrar em creative_publications (pra aparecer na lista "Publicações desse
-- anúncio" junto com o Mercado Livre). O CHECK de `marketplace` só permitia
-- mercado_livre/shopee/amazon/magalu — adiciona tiktok_shop (e tiktok).
--
-- Já APLICADA em prod via _admin_exec_sql (idempotente). Este arquivo é o registro.
--
-- Rollback:
--   ALTER TABLE creative_publications DROP CONSTRAINT IF EXISTS creative_publications_marketplace_check;
--   ALTER TABLE creative_publications ADD CONSTRAINT creative_publications_marketplace_check
--     CHECK (marketplace IN ('mercado_livre','shopee','amazon','magalu'));

ALTER TABLE creative_publications DROP CONSTRAINT IF EXISTS creative_publications_marketplace_check;
ALTER TABLE creative_publications ADD CONSTRAINT creative_publications_marketplace_check
  CHECK (marketplace IN ('mercado_livre', 'shopee', 'amazon', 'magalu', 'tiktok_shop', 'tiktok'));
