-- Product OS — Ficha de catálogo (transição projeto → produto pronto p/ IA Criativo)
-- O projeto (product_dev) passa a carregar uma "ficha" pronta para o catálogo:
-- título de marketplace, descrição rica, marca, atributos (ML), tags e bullets.
-- A IA preenche a partir da fonte (MakerWorld etc.); o operador valida no preview
-- e marca "pronto para IA Criativo". O publishToCatalog então cria o produto no
-- catálogo já COMPLETO (passa no checklist de completude que a IA Criativo/ML consomem).

alter table public.product_dev
  add column if not exists catalog_title       text,
  add column if not exists catalog_description text,
  add column if not exists catalog_brand       text,
  add column if not exists catalog_bullets     jsonb  not null default '[]'::jsonb,
  add column if not exists catalog_attributes  jsonb  not null default '{}'::jsonb,
  add column if not exists catalog_tags        jsonb  not null default '[]'::jsonb,
  add column if not exists catalog_ready       boolean not null default false,
  add column if not exists enrichment          jsonb;

comment on column public.product_dev.catalog_title       is 'Título de marketplace (ml_title) gerado/validado — vai pro produto no publish';
comment on column public.product_dev.catalog_description is 'Descrição rica (≥80 chars) — vai pro produto no publish';
comment on column public.product_dev.catalog_brand       is 'Marca comercial (brand) — ML quase sempre exige';
comment on column public.product_dev.catalog_bullets     is 'Bullets/benefícios (string[]) — apoio à descrição';
comment on column public.product_dev.catalog_attributes  is 'Atributos ML (mapa nome→valor) — semeia products.attributes';
comment on column public.product_dev.catalog_tags        is 'Tags/keywords (string[]) — semeia products.tags';
comment on column public.product_dev.catalog_ready       is 'Ficha validada pelo operador = pronto para IA Criativo';
comment on column public.product_dev.enrichment          is 'Última saída bruta da IA (ficha + classificação sugerida) p/ auditoria';
