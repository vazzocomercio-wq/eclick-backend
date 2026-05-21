-- Histórico de banners gerados pela IA.
--
-- Cada chamada ao /banner-generator/generate cria 1+ rows aqui (1 por
-- formato × variação). Permite a página dedicada de banners mostrar
-- histórico, reaplicar prompts, deletar, e reaproveitar URLs em outros
-- pontos da loja (Designer, Hero, etc).

CREATE TABLE IF NOT EXISTS public.generated_banners (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  image_url       text NOT NULL,                  -- URL pública no storage
  format          text NOT NULL,                  -- 'wide_desktop', 'square_mobile', etc
  style_key       text,                            -- chave do estilo usado
  prompt_used     text,                            -- prompt final enviado pra IA (audit/reuso)
  custom_prompt   boolean NOT NULL DEFAULT false,  -- se foi prompt custom ou template
  product_ids     uuid[] NOT NULL DEFAULT '{}',    -- produtos usados como contexto
  cost_usd        numeric(10, 6) DEFAULT 0,         -- custo aproximado da geração
  fallback_used   boolean NOT NULL DEFAULT false,   -- se caiu pra gpt-image-1
  variations      integer NOT NULL DEFAULT 1,       -- N variações pedidas
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_generated_banners_org_created
  ON public.generated_banners (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generated_banners_org_format
  ON public.generated_banners (organization_id, format, created_at DESC);

COMMENT ON TABLE public.generated_banners IS
  'Histórico de banners gerados pela IA — galeria + reuso.';

GRANT ALL ON TABLE public.generated_banners TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.generated_banners TO authenticated;
