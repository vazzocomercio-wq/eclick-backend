-- Product OS — Medidas do PRODUTO FINAL (para envio no anúncio)
-- O peso/dimensões do anúncio devem ser do produto COMPLETO (montado), não das
-- peças isoladas. Estes campos guardam a correção/medida final do produto:
--  - final_weight_g: peso corrigido do produto inteiro (sobrepõe o cálculo).
--  - final_width/depth/height_mm: medidas do produto MONTADO.
-- Quando vazios, o sistema calcula: peso = soma das peças × qtd (ou peso da versão);
-- dimensões = medidas informadas > bounding das peças > dimensões do briefing.

alter table public.product_dev
  add column if not exists final_weight_g  numeric,
  add column if not exists final_width_mm  numeric,
  add column if not exists final_depth_mm  numeric,
  add column if not exists final_height_mm numeric;

comment on column public.product_dev.final_weight_g  is 'Peso corrigido do produto COMPLETO (g) — sobrepõe a soma das peças/versão no publish';
comment on column public.product_dev.final_width_mm  is 'Largura do produto MONTADO (mm) — vai pro anúncio';
comment on column public.product_dev.final_depth_mm  is 'Profundidade/comprimento do produto MONTADO (mm)';
comment on column public.product_dev.final_height_mm is 'Altura do produto MONTADO (mm)';
