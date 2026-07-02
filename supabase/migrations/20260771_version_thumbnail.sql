-- Preview da peça extraído de dentro do .3mf (o slicer do Bambu embute o
-- render do prato em Metadata/plate_*.png). Mostrado nos cards de produção.
ALTER TABLE public.product_dev_version
  ADD COLUMN IF NOT EXISTS thumbnail_url text;
