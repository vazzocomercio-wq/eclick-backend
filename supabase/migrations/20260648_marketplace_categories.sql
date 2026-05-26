-- Espelho GENÉRICO de árvores de categoria de marketplaces (multi-marketplace).
--
-- Fundação dos "vínculos de categoria": além do ML (que vive em ml_categories),
-- cada marketplace tem sua taxonomia. Aqui guardamos a árvore de cada um, com
-- a mesma forma, pra mapear depois (category_links): categoria ML → categoria
-- do marketplace X.
--
-- marketplace: 'meta' (Instagram/Facebook catalog = Google Product Taxonomy),
--              'shopee', 'tiktok', 'amazon', ... (e eventualmente 'mercadolivre'
--              também, se quisermos unificar — por ora o ML segue em ml_categories
--              pra não mexer na vitrine que já lê de lá).
--
-- ⚠️ TABELA ISOLADA — só referência. Não toca em products nem em category_ml_id.
-- Dados públicos de taxonomia (sem dado de tenant).

CREATE TABLE IF NOT EXISTS public.marketplace_categories (
  marketplace     text NOT NULL,                     -- 'meta' | 'shopee' | 'tiktok' | 'amazon' ...
  external_id     text NOT NULL,                     -- id da categoria no marketplace
  parent_id       text,                              -- external_id do pai (NULL = raiz)
  name            text NOT NULL,                     -- nome da folha (último segmento)
  full_path       text,                              -- "Apparel & Accessories > Clothing > Shirts"
  path_from_root  jsonb,                             -- [{id,name}, ...] do topo até aqui
  level           integer NOT NULL DEFAULT 0,
  is_leaf         boolean NOT NULL DEFAULT false,
  raw             jsonb,
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (marketplace, external_id)
);

CREATE INDEX IF NOT EXISTS idx_mkt_categories_parent ON public.marketplace_categories (marketplace, parent_id);
CREATE INDEX IF NOT EXISTS idx_mkt_categories_leaf   ON public.marketplace_categories (marketplace, is_leaf);

COMMENT ON TABLE public.marketplace_categories IS
  'Mirror genérico de taxonomias de marketplace (meta/shopee/tiktok/amazon). Referência pros vínculos de categoria. Isolada — não toca em products.';

-- updated_at automático
CREATE OR REPLACE FUNCTION public.tg_mkt_categories_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_mkt_categories_touch ON public.marketplace_categories;
CREATE TRIGGER trg_mkt_categories_touch
  BEFORE UPDATE ON public.marketplace_categories
  FOR EACH ROW EXECUTE FUNCTION public.tg_mkt_categories_touch();

-- RLS: taxonomia pública. Escrita só service_role (crawler/importador); leitura liberada.
ALTER TABLE public.marketplace_categories ENABLE ROW LEVEL SECURITY;

-- GRANTs explícitos (tabela criada via _admin_exec_sql NÃO herda default privileges)
GRANT ALL    ON TABLE public.marketplace_categories TO service_role;
GRANT SELECT ON TABLE public.marketplace_categories TO authenticated, anon;

DROP POLICY IF EXISTS marketplace_categories_read ON public.marketplace_categories;
CREATE POLICY marketplace_categories_read ON public.marketplace_categories
  FOR SELECT TO authenticated, anon USING (true);
