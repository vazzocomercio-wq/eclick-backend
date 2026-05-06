-- Onda 1 / L2 — Landing page pública de produto.
--
-- Toggle landing_published controla se o produto fica acessível em rota
-- pública /p/:id. Default false — user precisa explicitamente publicar.
--
-- landing_slug opcional pra URLs amigáveis (sprint L2.2). UNIQUE per org.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS landing_published    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS landing_published_at timestamptz,
  ADD COLUMN IF NOT EXISTS landing_views        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS landing_slug         text;

-- Slug único por org (NULL é permitido, mas se setado, único)
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_landing_slug
  ON products(organization_id, landing_slug)
  WHERE landing_slug IS NOT NULL;

-- Index pra rota pública verificar publicado rapido
CREATE INDEX IF NOT EXISTS idx_products_landing_published
  ON products(id) WHERE landing_published = true;
