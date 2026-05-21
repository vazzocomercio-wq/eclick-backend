-- Loja Própria — resgate de cashback no checkout.
--
-- Adiciona cashback_used_cents em storefront_orders pra rastrear quanto
-- de cashback foi aplicado em cada pedido. Importante pra:
--  - Auditoria (cliente reclamar de desconto não aplicado)
--  - Hook após 'paid' debitar o saldo idempotentemente (source_id = order_id)
--  - Relatórios financeiros (quanto a loja "perdeu" em cashback resgatado)
--
-- total/subtotal já refletem o valor pago — cashback_used_cents é só
-- metadado complementar.

ALTER TABLE public.storefront_orders
  ADD COLUMN IF NOT EXISTS cashback_used_cents integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.storefront_orders.cashback_used_cents IS
  'Quantos centavos de cashback o cliente aplicou neste pedido. 0 = não usou.';

CREATE INDEX IF NOT EXISTS idx_storefront_orders_cashback_used
  ON public.storefront_orders (organization_id, created_at DESC)
  WHERE cashback_used_cents > 0;
