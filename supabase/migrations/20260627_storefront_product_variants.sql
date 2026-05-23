-- 20260627 — Vínculos de variantes de produto (cor/acabamento)
--
-- Frente "Provador de cor/acabamento IA" (A1): cada cor/acabamento é um PRODUTO
-- separado (a cor vive no nome/SKU; não há produto-pai com variações). Esta
-- tabela liga produtos que são variantes uns dos outros — definido e CONFIRMADO
-- pelo lojista no editor de produto do catálogo (sugestão por raiz de SKU, mas
-- o vínculo só nasce na confirmação).
--
-- Vínculo é mútuo na prática (o serviço cria o grafo completo entre os produtos
-- de um grupo), mas guardamos como pares direcionais base->variant pra simplicidade.

CREATE TABLE IF NOT EXISTS public.storefront_product_variants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  base_product_id    uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  variant_product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  label              text,           -- rótulo de cor/acabamento (ex: "Dourado"); null = deriva do produto
  position           integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, base_product_id, variant_product_id),
  CONSTRAINT storefront_product_variants_no_self CHECK (base_product_id <> variant_product_id)
);

CREATE INDEX IF NOT EXISTS idx_spv_org_base
  ON public.storefront_product_variants (organization_id, base_product_id, position);

-- GRANTs (tabela criada via RPC não herda default privileges — RLS é layer 2).
GRANT ALL ON TABLE public.storefront_product_variants TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.storefront_product_variants TO authenticated;
