-- Wishlist (favoritos) do cliente da Loja Própria.
--
-- 1 row por (cliente, produto). Cliente loga e adiciona produtos
-- pra ver depois. Botão coração no ProductCard da vitrine.

CREATE TABLE IF NOT EXISTS public.customer_wishlists (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    uuid NOT NULL REFERENCES public.storefront_customers(id) ON DELETE CASCADE,
  product_id     uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_customer_wishlists
  ON public.customer_wishlists (customer_id, product_id);

CREATE INDEX IF NOT EXISTS idx_customer_wishlists_customer
  ON public.customer_wishlists (customer_id, created_at DESC);

COMMENT ON TABLE public.customer_wishlists IS
  'Lista de favoritos do cliente da Loja Própria.';

GRANT ALL ON TABLE public.customer_wishlists TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_wishlists TO authenticated;
