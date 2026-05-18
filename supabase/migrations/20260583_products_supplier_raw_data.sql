-- Sessão 2026-05-18 (e-Click Saas 23) — Enriquecimento de produtos com os
-- dados do fornecedor (Icarus/Pennacorp).
--
-- 1. Nova coluna products.supplier_raw_data (jsonb): guarda o payload COMPLETO
--    da API do fornecedor — nenhum campo se perde, mesmo os sem coluna própria
--    (pt_unid, pt_multiplo, pt_curva, mercado, pt_codegroup, pt_cadastro, ...).
-- 2. Backfill: enriquece todos os produtos já vinculados a itens sincronizados
--    do catálogo Icarus. Os campos estruturados (descrição, categoria, gtin,
--    peso, dimensões) só são preenchidos se estiverem VAZIOS — não sobrescreve
--    dado já curado pelo usuário. supplier_raw_data é sempre atualizado.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS supplier_raw_data jsonb;

COMMENT ON COLUMN public.products.supplier_raw_data IS
  'Payload completo do fornecedor (Icarus/Pennacorp) que originou/atualizou este produto. Garante que nenhum campo da API se perca.';

-- Backfill dos produtos já sincronizados via Icarus.
UPDATE public.products p
SET
  supplier_raw_data = sci.raw,
  description = COALESCE(NULLIF(btrim(p.description), ''), NULLIF(btrim(sci.raw->>'pt_obs'), ''), p.description),
  category    = COALESCE(NULLIF(btrim(p.category), ''),    NULLIF(btrim(sci.raw->>'fa_nome'), ''), p.category),
  gtin        = COALESCE(NULLIF(btrim(p.gtin), ''),        NULLIF(btrim(sci.raw->>'pb_codbar'), ''), p.gtin),
  weight_kg   = COALESCE(
                  NULLIF(p.weight_kg, 0),
                  CASE WHEN sci.raw->>'pb_peso'    ~ '^[0-9]+([.][0-9]+)?$' THEN NULLIF((sci.raw->>'pb_peso')::numeric, 0) END,
                  CASE WHEN sci.raw->>'pt_pesoliq' ~ '^[0-9]+([.][0-9]+)?$' THEN NULLIF((sci.raw->>'pt_pesoliq')::numeric, 0) END,
                  p.weight_kg),
  height_cm   = COALESCE(NULLIF(p.height_cm, 0), CASE WHEN sci.raw->>'pb_altura'  ~ '^[0-9]+([.][0-9]+)?$' THEN NULLIF((sci.raw->>'pb_altura')::numeric, 0) END, p.height_cm),
  width_cm    = COALESCE(NULLIF(p.width_cm, 0),  CASE WHEN sci.raw->>'pb_largura' ~ '^[0-9]+([.][0-9]+)?$' THEN NULLIF((sci.raw->>'pb_largura')::numeric, 0) END, p.width_cm),
  length_cm   = COALESCE(NULLIF(p.length_cm, 0), CASE WHEN sci.raw->>'pb_comprim' ~ '^[0-9]+([.][0-9]+)?$' THEN NULLIF((sci.raw->>'pb_comprim')::numeric, 0) END, p.length_cm),
  updated_at  = now()
FROM public.supplier_catalog_items sci
WHERE sci.matched_product_id = p.id
  AND sci.organization_id = p.organization_id
  AND sci.sync_status = 'synced'
  AND sci.raw IS NOT NULL
  AND sci.raw <> '{}'::jsonb;
