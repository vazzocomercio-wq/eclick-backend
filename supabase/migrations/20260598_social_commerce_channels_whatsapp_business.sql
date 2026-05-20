-- Quando estendemos o enum SocialCommerceChannel em codigo pra incluir
-- 'whatsapp_business' (W1 — Backend WhatsApp Catalog), esquecemos de
-- expandir o check constraint correspondente na tabela. Resultado:
-- insert/update com `channel='whatsapp_business'` falha com:
--
--   new row for relation "social_commerce_channels" violates check
--   constraint "social_commerce_channels_channel_check"
--
-- Aplicado em prod via _admin_exec_sql em 2026-05-20.

ALTER TABLE public.social_commerce_channels
  DROP CONSTRAINT IF EXISTS social_commerce_channels_channel_check;

ALTER TABLE public.social_commerce_channels
  ADD CONSTRAINT social_commerce_channels_channel_check
  CHECK (channel IN (
    'instagram_shop',
    'facebook_shop',
    'tiktok_shop',
    'google_shopping',
    'whatsapp_business'
  ));
