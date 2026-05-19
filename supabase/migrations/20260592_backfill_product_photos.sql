-- Sessão 2026-05-19 (e-Click Saas 23) — Backfill de fotos dos produtos.
--
-- Produtos sincronizados do Icarus ficaram com photo_urls nulo enquanto a
-- imagem existe em supplier_catalog_items.image_url (catálogo do fornecedor,
-- ex: https://www.cinderelladecor.com.br/imagens/{sku}.jpg). Copiamos a
-- imagem do catálogo pro produto SÓ quando o produto ainda não tem foto —
-- não sobrescreve nada que o usuário já cadastrou. ~697 produtos.

UPDATE public.products p
SET photo_urls = ARRAY[sci.image_url],
    updated_at = now()
FROM public.supplier_catalog_items sci
WHERE sci.external_code   = p.sku
  AND sci.organization_id = p.organization_id
  AND sci.image_url IS NOT NULL
  AND sci.image_url <> ''
  AND (p.photo_urls IS NULL OR cardinality(p.photo_urls) = 0);
