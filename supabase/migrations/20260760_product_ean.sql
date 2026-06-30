-- ============================================================
-- Product OS — Gerador de EAN-13 interno (1 clique)
--
-- EAN-13 estruturalmente válido (dígito verificador correto) com prefixo "2" =
-- faixa de CIRCULAÇÃO RESTRITA / uso interno do GS1 (reservada p/ códigos
-- internos; não pertence a nenhuma empresa no mundo → nunca colide com produto
-- real). Serve como código de barras escaneável p/ Shopee/TikTok/loja/WMS
-- enquanto não há registro GS1 oficial. No ML, usar como SKU do vendedor e
-- declarar "sem GTIN" (não como GTIN oficial). EAN por VARIANTE de cor (unidade
-- vendável); produto sem variantes tem o seu. 100% aditivo.
-- ============================================================

ALTER TABLE product_dev_sku_variant ADD COLUMN IF NOT EXISTS ean TEXT;
ALTER TABLE product_dev              ADD COLUMN IF NOT EXISTS ean TEXT;

-- EAN único por org (evita duplicar entre produtos/variantes)
CREATE UNIQUE INDEX IF NOT EXISTS ux_pdsv_ean ON product_dev_sku_variant(organization_id, ean) WHERE ean IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pd_ean   ON product_dev(organization_id, ean) WHERE ean IS NOT NULL;
