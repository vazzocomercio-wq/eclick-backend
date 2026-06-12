-- 20260709 — Central de Avaliações (Shopee é a 1ª plataforma).
-- Avaliações de produto agnósticas de plataforma: ingestão via
-- product/get_comment, resposta via product/reply_comment (pública!).

CREATE TABLE IF NOT EXISTS public.marketplace_reviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES public.organizations(id),
  platform           text NOT NULL DEFAULT 'shopee',
  shop_id            text,                     -- loja (multi-loja)
  external_review_id text NOT NULL,            -- comment_id da plataforma
  item_id            text,                     -- anúncio avaliado
  model_id           text,
  order_sn           text,                     -- pedido de origem
  buyer_username     text,
  rating             integer,                  -- 1..5 estrelas
  comment            text,                     -- texto (pode ser vazio: só estrelas)
  media              jsonb NOT NULL DEFAULT '{}'::jsonb,  -- fotos/vídeos do comprador
  reply_text         text,                     -- resposta do vendedor (quando houver)
  replied_at         timestamptz,
  editable           text,                     -- EDITABLE/EXPIRED (janela de resposta)
  hidden             boolean,
  review_create_at   timestamptz,
  raw                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, platform, external_review_id)
);

CREATE INDEX IF NOT EXISTS idx_mp_reviews_org_rating
  ON public.marketplace_reviews (organization_id, platform, rating);
CREATE INDEX IF NOT EXISTS idx_mp_reviews_org_created
  ON public.marketplace_reviews (organization_id, review_create_at DESC);
CREATE INDEX IF NOT EXISTS idx_mp_reviews_org_unreplied
  ON public.marketplace_reviews (organization_id, platform)
  WHERE reply_text IS NULL;
CREATE INDEX IF NOT EXISTS idx_mp_reviews_org_item
  ON public.marketplace_reviews (organization_id, item_id);

-- GRANTs explícitos (tabela via _admin_exec_sql não herda default privileges)
GRANT ALL ON TABLE public.marketplace_reviews TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.marketplace_reviews TO authenticated;

ALTER TABLE public.marketplace_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mp_reviews_org_isolation ON public.marketplace_reviews;
CREATE POLICY mp_reviews_org_isolation ON public.marketplace_reviews
  FOR ALL TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));
