-- 20260650_oauth_state_tiktok_shop.sql
-- Permite provider 'tiktok_shop' (e 'shopee') no oauth_state — o CHECK
-- anterior só aceitava canva/meta/mercadolivre/google/stripe/mercadopago/
-- screenshotone, o que fazia o início do OAuth do TikTok Shop falhar.
-- (Já aplicado em produção; este arquivo mantém o histórico do repo alinhado.)
ALTER TABLE public.oauth_state DROP CONSTRAINT IF EXISTS oauth_state_provider_check;
ALTER TABLE public.oauth_state ADD CONSTRAINT oauth_state_provider_check
  CHECK (provider = ANY (ARRAY[
    'canva','meta','mercadolivre','google','stripe',
    'mercadopago','screenshotone','tiktok_shop','shopee'
  ]));
