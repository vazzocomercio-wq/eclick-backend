-- Product OS — categoria do Mercado Livre na ficha do produto.
-- Em vez de categoria em texto livre, o projeto guarda a categoria REAL da árvore
-- do ML (a mesma que já espelhamos em public.ml_categories / prevemos por título).
-- No publish isso vira products.category_ml_id → produto já cai na categoria certa
-- do ML e a IA Criativo puxa os atributos obrigatórios daquela categoria.

alter table public.product_dev
  add column if not exists category_ml_id   text,
  add column if not exists category_ml_path jsonb;

comment on column public.product_dev.category_ml_id   is 'Categoria do Mercado Livre (MLBxx, folha da árvore) — vai pro products.category_ml_id no publish';
comment on column public.product_dev.category_ml_path is 'path_from_root da categoria ML ([{id,name}…]) p/ mostrar o caminho Categoria › Sub';
