-- Espelho da árvore de categorias do Mercado Livre (referência do catálogo).
--
-- ⚠️ TABELA ISOLADA — NÃO toca em `products`. Os produtos continuam conectados
-- à categoria do ML via API exatamente como hoje (products.category_ml_id).
-- Não há FK de products pra cá, não alteramos category_ml_id, não desconectamos
-- nada. Isto é só um mirror de REFERÊNCIA (puxado da API pública do ML) pra:
--   1. resolver nome + breadcrumb da categoria de um produto (leitura);
--   2. servir de fonte pros futuros "vínculos de categoria" (multi-marketplace),
--      que viverão no catálogo de produto — NÃO aqui, NÃO na loja.
--
-- A Loja Própria é só um canal: monta navegação a partir da categoria DOS
-- PRODUTOS (category_ml_id) resolvida contra esta tabela, mostrando só as
-- categorias que têm produto (vazia = oculta).
--
-- Dados são públicos e universais (taxonomia do ML, não há dado de tenant).

CREATE TABLE IF NOT EXISTS public.ml_categories (
  id              text PRIMARY KEY,                 -- id da categoria ML, ex 'MLB5672'
  site_id         text NOT NULL DEFAULT 'MLB',
  parent_id       text,                              -- id do pai (NULL = raiz de domínio)
  name            text NOT NULL,
  path_from_root  jsonb,                             -- [{id,name}, ...] do topo até aqui
  level           integer NOT NULL DEFAULT 0,        -- profundidade (raiz = 0)
  is_leaf         boolean NOT NULL DEFAULT false,    -- sem filhos = folha (onde se anuncia no ML)
  total_items     bigint,                            -- total_items_in_this_category (snapshot)
  children_count  integer NOT NULL DEFAULT 0,
  raw             jsonb,                             -- payload bruto do /categories/{id} (debug/futuro)
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_categories_parent ON public.ml_categories (parent_id);
CREATE INDEX IF NOT EXISTS idx_ml_categories_site   ON public.ml_categories (site_id);
CREATE INDEX IF NOT EXISTS idx_ml_categories_leaf   ON public.ml_categories (site_id, is_leaf);

COMMENT ON TABLE public.ml_categories IS
  'Mirror da árvore de categorias do ML (referência do catálogo). Isolada — não toca em products.';

-- updated_at automático
CREATE OR REPLACE FUNCTION public.tg_ml_categories_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_ml_categories_touch ON public.ml_categories;
CREATE TRIGGER trg_ml_categories_touch
  BEFORE UPDATE ON public.ml_categories
  FOR EACH ROW EXECUTE FUNCTION public.tg_ml_categories_touch();

-- RLS: dado público de taxonomia (sem dado de tenant). Escrita só service_role
-- (crawler do backend). Leitura liberada (a vitrine resolve via backend mesmo).
ALTER TABLE public.ml_categories ENABLE ROW LEVEL SECURITY;

-- GRANTs explícitos (tabela criada via _admin_exec_sql NÃO herda default privileges)
GRANT ALL    ON TABLE public.ml_categories TO service_role;
GRANT SELECT ON TABLE public.ml_categories TO authenticated, anon;

DROP POLICY IF EXISTS ml_categories_read ON public.ml_categories;
CREATE POLICY ml_categories_read ON public.ml_categories
  FOR SELECT TO authenticated, anon USING (true);
