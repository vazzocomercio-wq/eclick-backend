-- Multiplicação de Anúncios — fila de drafts (produto canônico → canal destino).
-- Um draft é a proposta revisável de "copiar este produto/anúncio pro canal X":
-- payload jsonb carrega título/descrição/preço/fotos já adaptados ao destino;
-- o publish despacha pro publicador existente do canal (Shopee add_item,
-- TikTok create product, storefront visibility) — que já cria o vínculo em
-- product_listings e aplica a regra central de estoque.

CREATE TABLE IF NOT EXISTS public.multiplier_drafts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_id         uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,

  -- anúncio de origem (opcional — pode multiplicar direto do produto)
  source_platform    text,
  source_listing_id  text,

  target_platform    text NOT NULL CHECK (target_platform IN ('shopee','tiktok_shop','storefront','mercadolivre')),
  target_account_id  text,            -- shop_id (Shopee) / null (TikTok 1-loja, storefront)

  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','publishing','published','failed','discarded')),
  error_message      text,
  external_id        text,            -- item_id/product_id criado no destino

  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  published_at       timestamptz
);

CREATE INDEX IF NOT EXISTS idx_multiplier_drafts_org_status
  ON public.multiplier_drafts (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_multiplier_drafts_product
  ON public.multiplier_drafts (product_id);

-- 1 draft ABERTO por produto+destino+conta (idempotência da fila)
CREATE UNIQUE INDEX IF NOT EXISTS uq_multiplier_drafts_open
  ON public.multiplier_drafts (organization_id, product_id, target_platform, COALESCE(target_account_id, ''))
  WHERE status IN ('draft','publishing');

ALTER TABLE public.multiplier_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS multiplier_drafts_org_all ON public.multiplier_drafts;
CREATE POLICY multiplier_drafts_org_all ON public.multiplier_drafts
  FOR ALL TO authenticated
  USING (organization_id IN (SELECT get_user_org_ids()))
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()));

-- GRANTs base (tabela criada via _admin_exec_sql não herda defaults do CLI)
GRANT ALL ON TABLE public.multiplier_drafts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.multiplier_drafts TO authenticated;
