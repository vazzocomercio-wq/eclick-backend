-- Product OS — fotos ocultadas do anúncio. O lojista tira com o × no modal de
-- publicar; a foto CONTINUA no produto (reference_images/protótipo), só não
-- entra no anúncio por padrão. É a lista de URLs "escondidas" por produto.
ALTER TABLE public.product_dev
  ADD COLUMN IF NOT EXISTS hidden_photo_urls text[] NOT NULL DEFAULT '{}';
