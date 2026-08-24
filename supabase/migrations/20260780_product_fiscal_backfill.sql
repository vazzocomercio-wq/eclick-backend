-- Faturador F2b-3 (passo 4) — unificação dos dados fiscais de produto.
--
-- Hoje existem DUAS fontes desconectadas: products.fiscal (jsonb — preenchido
-- pelo cadastro/import de produtos, ex.: NF-e de compra de insumo) e a tabela
-- product_fiscal (painel do Faturador — fonte canônica da emissão).
-- Este backfill copia jsonb → tabela onde a tabela ainda não tem linha
-- (idempotente: ON CONFLICT DO NOTHING). A emissão lê product_fiscal com
-- fallback em products.fiscal (FulfillmentFiscalService.resolveProductFiscal).

INSERT INTO public.product_fiscal (organization_id, product_id, ncm, cest, origem, unit)
SELECT p.organization_id,
       p.id,
       nullif(trim(p.fiscal->>'ncm'), ''),
       nullif(trim(p.fiscal->>'cest'), ''),
       nullif(trim(p.fiscal->>'origem'), ''),
       'UN'
FROM public.products p
WHERE p.fiscal IS NOT NULL
  AND coalesce(trim(p.fiscal->>'ncm'), '') <> ''
ON CONFLICT (organization_id, product_id) DO NOTHING;
