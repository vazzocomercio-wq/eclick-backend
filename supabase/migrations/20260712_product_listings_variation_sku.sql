-- Vínculo por VARIAÇÃO: anúncio (model Shopee / variação ML) ↔ variação do
-- catálogo (products.variations[].sku, JSONB do cadastro).
--
-- `variation_id` continua sendo o id da variação NO MARKETPLACE (model_id da
-- Shopee, variation_id do ML). A coluna nova aponta pra variação do CATÁLOGO
-- pela chave estável que o lojista mantém nos dois lados: o SKU da variação
-- (ex: VZ-10010501-54 = Creme). Não usamos o `id` do JSONB porque ele é
-- gerado pelo formulário (instável entre edições).

ALTER TABLE public.product_listings
  ADD COLUMN IF NOT EXISTS product_variation_sku text NULL;

COMMENT ON COLUMN public.product_listings.product_variation_sku IS
  'SKU da variação do CATÁLOGO (products.variations[].sku) apontada por este vínculo. NULL = vínculo nível-produto. variation_id = id da variação no marketplace.';

CREATE INDEX IF NOT EXISTS idx_product_listings_prod_var_sku
  ON public.product_listings (product_id, product_variation_sku)
  WHERE product_variation_sku IS NOT NULL;
