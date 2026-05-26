-- Vínculos de categoria entre marketplaces (Cat-5).
--
-- Mapeia a NOSSA categoria canônica (= categoria do ML por enquanto) para a
-- categoria equivalente em cada marketplace de DESTINO (Meta/Instagram, Shopee,
-- TikTok, Amazon). Vínculo por CATEGORIA, não por produto: mapeia "Arandelas
-- (MLB189196)" → "Acessórios para iluminação (Meta 2956)" uma vez, e todos os
-- produtos daquela categoria ML herdam.
--
-- ⚠️ NÃO toca em products nem em category_ml_id. O publish em cada marketplace
-- consulta este vínculo pra saber a categoria de destino; o produto continua
-- com seu category_ml_id intacto.

CREATE TABLE IF NOT EXISTS public.category_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_marketplace  text NOT NULL DEFAULT 'mercadolivre',  -- nossa categoria canônica
  source_category_id  text NOT NULL,                          -- ex 'MLB189196'
  target_marketplace  text NOT NULL,                          -- 'meta' | 'shopee' | 'tiktok' | 'amazon'
  target_category_id  text NOT NULL,                          -- id da categoria no marketplace de destino
  target_path         text,                                   -- breadcrumb do destino (exibição)
  status              text NOT NULL DEFAULT 'confirmed',      -- 'confirmed' | 'suggested'
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- 1 vínculo por (org, categoria de origem, marketplace de destino)
CREATE UNIQUE INDEX IF NOT EXISTS category_links_uniq
  ON public.category_links (organization_id, source_marketplace, source_category_id, target_marketplace);

CREATE INDEX IF NOT EXISTS category_links_org_target_idx
  ON public.category_links (organization_id, target_marketplace);

COMMENT ON TABLE public.category_links IS
  'Vínculos de categoria: categoria canônica (ML) -> categoria de outro marketplace. Por categoria, herdado pelos produtos. Não toca em products.';

-- updated_at automático
CREATE OR REPLACE FUNCTION public.tg_category_links_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_category_links_touch ON public.category_links;
CREATE TRIGGER trg_category_links_touch
  BEFORE UPDATE ON public.category_links
  FOR EACH ROW EXECUTE FUNCTION public.tg_category_links_touch();

ALTER TABLE public.category_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS category_links_select_own ON public.category_links;
CREATE POLICY category_links_select_own ON public.category_links FOR SELECT
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS category_links_modify_own ON public.category_links;
CREATE POLICY category_links_modify_own ON public.category_links FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ))
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

-- GRANTs (tabela criada via _admin_exec_sql não herda defaults)
GRANT ALL ON TABLE public.category_links TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.category_links TO authenticated;
