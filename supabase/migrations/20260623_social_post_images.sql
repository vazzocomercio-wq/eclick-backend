-- e-Click Social AI — Fase SV1: geração visual de imagem por IA.
--
-- Dado um produto, a IA gera imagens em formato social (feed 1:1, story/
-- reels 9:16) usando a foto do produto como referência (Gemini multi-image
-- edit, feature `creative_image`). Cada imagem gerada é persistida aqui +
-- no bucket público `storefront-assets` (prefixo social/).
--
-- Galeria reutilizável: o lojista gera, baixa, e (fase seguinte) anexa a
-- uma peça de social_content pra publicar via Active.

CREATE TABLE IF NOT EXISTS public.social_post_images (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_id        uuid REFERENCES public.products(id) ON DELETE SET NULL,
  user_id           uuid,

  format            text NOT NULL DEFAULT 'feed'
                     CHECK (format IN ('feed', 'story', 'wide')),
  style             text,            -- lifestyle, studio, promo, seasonal, minimal, vibrant
  prompt            text,            -- prompt efetivo usado (pra auditoria/regen)

  image_url         text NOT NULL,   -- URL pública no bucket storefront-assets
  storage_path      text,            -- {orgId}/social/{uuid}.png

  provider          text,            -- google / openai
  model             text,
  cost_usd          numeric(10,6) DEFAULT 0,

  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_social_post_images_org
  ON public.social_post_images (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_social_post_images_product
  ON public.social_post_images (organization_id, product_id, created_at DESC);

COMMENT ON TABLE public.social_post_images IS
  'Imagens de post social geradas por IA (e-Click Social AI SV1). Foto do produto vira cena social.';

-- Grants (criação via _admin_exec_sql não herda default privileges)
GRANT ALL ON TABLE public.social_post_images TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.social_post_images TO authenticated;
