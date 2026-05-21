-- Loja Própria — avaliações de produtos (Z1).
--
-- Cliente que comprou (storefront_customers) e recebeu (storefront_orders
-- com shipping_status='delivered') pode avaliar cada produto do pedido.
--
-- Fluxo:
--   1. Cliente vê "Avaliar" na sua /conta/pedidos pra cada item de pedido
--      delivered que ainda não foi avaliado.
--   2. Submete rating 1-5 + título + texto. Vai pra `status='pending'` ou
--      `'approved'` direto se o lojista habilitou `auto_approve`.
--   3. Lojista modera em /dashboard/loja/reviews (aprova / rejeita /
--      responde).
--   4. Aprovação dispara recálculo do agregado `review_count` + `review_avg`
--      em `products` (denormalizado pra performance no grid público).
--
-- Política: UNIQUE (customer_id, product_id, order_id) — 1 review por
-- produto-por-pedido. Cliente que comprou o mesmo produto em 2 pedidos
-- diferentes pode avaliar 2x (justo — pode ter recebido condições
-- diferentes).
--
-- Storage: photos opcional, até 3 fotos do produto recebido. Cada item
-- é { url, width?, height? }. Bucket reutiliza `storefront-assets` por
-- ora (path /reviews/{org_id}/{review_id}/N.jpg).

CREATE TABLE IF NOT EXISTS public.product_reviews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_id          uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  customer_id         uuid NOT NULL REFERENCES public.storefront_customers(id) ON DELETE CASCADE,
  order_id            uuid REFERENCES public.storefront_orders(id) ON DELETE SET NULL,

  rating              smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title               text,
  body                text NOT NULL,
  photos              jsonb NOT NULL DEFAULT '[]'::jsonb,
                       -- [{ url, width?, height? }] — max 3 itens (validado no service)

  status              text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'rejected')),

  -- Resposta opcional do lojista (pública junto da review)
  store_reply         text,
  store_reply_at      timestamptz,

  -- Métrica social
  helpful_count       int NOT NULL DEFAULT 0,

  -- Moderação
  approved_at         timestamptz,
  rejected_at         timestamptz,
  rejection_reason    text,
  auto_approved       boolean NOT NULL DEFAULT false,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- 1 review por (cliente, produto, pedido). order_id NULL é tratado como
-- bucket separado (não conta como duplicata) — mas no fluxo normal sempre
-- vem com order_id pra rastrear elegibilidade.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_product_reviews_customer_product_order
  ON public.product_reviews (customer_id, product_id, COALESCE(order_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Listagem pública por produto: só aprovadas, mais recentes primeiro
CREATE INDEX IF NOT EXISTS idx_product_reviews_public
  ON public.product_reviews (product_id, created_at DESC)
  WHERE status = 'approved';

-- Fila de moderação do lojista
CREATE INDEX IF NOT EXISTS idx_product_reviews_queue
  ON public.product_reviews (organization_id, status, created_at DESC);

-- Lookup do "minhas avaliações" do cliente
CREATE INDEX IF NOT EXISTS idx_product_reviews_customer
  ON public.product_reviews (customer_id, created_at DESC);

COMMENT ON TABLE  public.product_reviews IS
  'Avaliações de produto na Loja Própria (vitrine pública). Cliente avalia depois que o pedido vira delivered.';
COMMENT ON COLUMN public.product_reviews.status IS
  'pending: aguarda moderação | approved: visível na vitrine | rejected: oculta.';
COMMENT ON COLUMN public.product_reviews.auto_approved IS
  'true quando review_settings.auto_approve estava on no momento da criação.';

-- Trigger updated_at
CREATE OR REPLACE FUNCTION public.tg_product_reviews_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_product_reviews_touch ON public.product_reviews;
CREATE TRIGGER trg_product_reviews_touch
  BEFORE UPDATE ON public.product_reviews
  FOR EACH ROW EXECUTE FUNCTION public.tg_product_reviews_touch();


-- ──────────────────────────────────────────────────────────────────────
-- Agregados denormalizados em products (rating médio + contagem)
-- ──────────────────────────────────────────────────────────────────────
-- review_count: número de reviews APROVADAS.
-- review_avg:   média do rating das APROVADAS, 0.00 a 5.00 (NULL se sem
--                reviews ainda).
-- Recalculado pelo service via função `recompute_product_review_aggregate`
-- a cada aprovação / rejeição / delete. Evita scan em listagens públicas.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS review_count int NOT NULL DEFAULT 0;
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS review_avg   numeric(3, 2);

-- Função utilitária pra recompute on-demand
CREATE OR REPLACE FUNCTION public.recompute_product_review_aggregate(p_product_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.products p
  SET review_count = sub.cnt,
      review_avg   = sub.avg
  FROM (
    SELECT COUNT(*)::int AS cnt,
           CASE WHEN COUNT(*) > 0 THEN ROUND(AVG(rating)::numeric, 2) ELSE NULL END AS avg
    FROM public.product_reviews
    WHERE product_id = p_product_id
      AND status = 'approved'
  ) sub
  WHERE p.id = p_product_id;
END;
$$;

COMMENT ON FUNCTION public.recompute_product_review_aggregate(uuid) IS
  'Recalcula review_count + review_avg em products. Chamar após approve/reject/delete em product_reviews.';


-- ──────────────────────────────────────────────────────────────────────
-- Settings na store_config (auto-approve, min chars, ask depois de X dias)
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.store_config
  ADD COLUMN IF NOT EXISTS review_settings jsonb NOT NULL DEFAULT
  '{"auto_approve":false,"min_body_chars":20,"max_photos":3,"ask_after_days":3,"hide_customer_full_name":true}'::jsonb;

COMMENT ON COLUMN public.store_config.review_settings IS
  'Config de moderação de reviews: { auto_approve, min_body_chars, max_photos, ask_after_days, hide_customer_full_name }.';


-- ──────────────────────────────────────────────────────────────────────
-- Grants (criação via _admin_exec_sql NÃO herda)
-- ──────────────────────────────────────────────────────────────────────
GRANT ALL ON TABLE public.product_reviews TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_reviews TO authenticated;
