-- 20260630 — Cupom no pedido da Loja Própria (C5)
--
-- Auditoria: o checkout não recebia couponCode; o desconto ficava só no front
-- e o incrementUsage nunca rodava (usage_limit/validade por uso ignorados).
-- Pra aplicar+contabilizar server-side, o pedido precisa registrar o cupom.

ALTER TABLE public.storefront_orders
  ADD COLUMN IF NOT EXISTS coupon_code text,
  ADD COLUMN IF NOT EXISTS coupon_discount_cents integer NOT NULL DEFAULT 0;
