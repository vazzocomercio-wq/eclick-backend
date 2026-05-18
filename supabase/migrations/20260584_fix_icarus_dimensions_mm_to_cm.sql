-- Sessão 2026-05-18 (e-Click Saas 23) — Correção de unidade das dimensões.
--
-- A API da Pennacorp envia dimensões em MILÍMETROS; o backfill da migration
-- 20260583 gravou esses valores crus nas colunas *_cm (centímetros).
-- Esta migration corrige: divide por 10 os valores que vieram do import,
-- identificados por baterem EXATAMENTE com o valor cru em supplier_raw_data.
-- Não toca em dimensão curada pelo usuário (valor diferente do cru).
-- Peso não precisa de correção — a Pennacorp já envia em quilos.

UPDATE public.products p
SET height_cm = round((p.supplier_raw_data->>'pb_altura')::numeric / 10.0, 2)
WHERE p.supplier_raw_data ? 'pb_altura'
  AND (p.supplier_raw_data->>'pb_altura') ~ '^[0-9]+([.][0-9]+)?$'
  AND (p.supplier_raw_data->>'pb_altura')::numeric > 0
  AND p.height_cm = (p.supplier_raw_data->>'pb_altura')::numeric;

UPDATE public.products p
SET width_cm = round((p.supplier_raw_data->>'pb_largura')::numeric / 10.0, 2)
WHERE p.supplier_raw_data ? 'pb_largura'
  AND (p.supplier_raw_data->>'pb_largura') ~ '^[0-9]+([.][0-9]+)?$'
  AND (p.supplier_raw_data->>'pb_largura')::numeric > 0
  AND p.width_cm = (p.supplier_raw_data->>'pb_largura')::numeric;

UPDATE public.products p
SET length_cm = round((p.supplier_raw_data->>'pb_comprim')::numeric / 10.0, 2)
WHERE p.supplier_raw_data ? 'pb_comprim'
  AND (p.supplier_raw_data->>'pb_comprim') ~ '^[0-9]+([.][0-9]+)?$'
  AND (p.supplier_raw_data->>'pb_comprim')::numeric > 0
  AND p.length_cm = (p.supplier_raw_data->>'pb_comprim')::numeric;
