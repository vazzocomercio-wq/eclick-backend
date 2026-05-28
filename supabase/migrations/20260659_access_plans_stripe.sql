-- F17-A5 · Stripe Products/Prices na access_plans + atualiza price_brl
-- Adiciona colunas stripe_product_id/stripe_price_id (preenchidas pelo
-- bootstrap script via Stripe API) e seta preços conservadores R$ 99/299/599/199.

ALTER TABLE public.access_plans
  ADD COLUMN IF NOT EXISTS stripe_product_id text,
  ADD COLUMN IF NOT EXISTS stripe_price_id   text;

COMMENT ON COLUMN public.access_plans.stripe_product_id IS 'Stripe Product ID criado via API (prod_xxx). Único globalmente no Stripe.';
COMMENT ON COLUMN public.access_plans.stripe_price_id   IS 'Stripe Price ID monthly BRL (price_xxx). Recurring. UNIQUE.';

-- Preços conservadores
UPDATE public.access_plans SET price_brl = 99.00,  updated_at = now() WHERE key = 'starter';
UPDATE public.access_plans SET price_brl = 299.00, updated_at = now() WHERE key = 'pro';
UPDATE public.access_plans SET price_brl = 599.00, updated_at = now() WHERE key = 'max';
UPDATE public.access_plans SET price_brl = 199.00, updated_at = now() WHERE key = 'active';
