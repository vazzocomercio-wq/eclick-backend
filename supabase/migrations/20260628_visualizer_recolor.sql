-- 20260628 — Provador de cor/acabamento (PV2): marca gerações de recolor
--
-- O recolor reusa a tabela storefront_visualizer_generations + a mesma cota.
-- Adiciona 'kind' (compose | recolor) e a variante alvo, pra distinguir nas
-- métricas/galeria.

ALTER TABLE public.storefront_visualizer_generations
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'compose',
  ADD COLUMN IF NOT EXISTS variant_product_id uuid;
