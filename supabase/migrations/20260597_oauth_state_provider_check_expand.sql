-- O check constraint `oauth_state_provider_check` aceitava apenas
-- valores antigos (provavelmente só 'canva'), o que quebrou o OAuth
-- do Meta:
--
--   new row for relation "oauth_state" violates check constraint
--   "oauth_state_provider_check"
--
-- Expandido pra incluir todos os providers em uso ou planejados:
--   canva           — design import (Canva OAuth PKCE)
--   meta            — Facebook/Instagram/WhatsApp Business (Meta OAuth)
--   mercadolivre    — ML OAuth (token storage em ml_connections, mas
--                     state pode passar por oauth_state se migrarmos)
--   google          — futuro Google Shopping / Analytics
--   stripe          — futuro Stripe Connect
--   mercadopago     — futuro Mercado Pago OAuth pro split de pagamento
--   screenshotone   — provider de credenciais (apesar de nao usar OAuth
--                     state, fica como reserva)
--
-- Aplicado em prod via _admin_exec_sql em 2026-05-20.

ALTER TABLE public.oauth_state DROP CONSTRAINT IF EXISTS oauth_state_provider_check;

ALTER TABLE public.oauth_state ADD CONSTRAINT oauth_state_provider_check
  CHECK (provider IN ('canva', 'meta', 'mercadolivre', 'google', 'stripe', 'mercadopago', 'screenshotone'));
