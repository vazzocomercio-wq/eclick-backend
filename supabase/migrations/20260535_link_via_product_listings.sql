-- M4 fix: a função de auto-link só usava products.sku == ml_campaign_items.seller_sku
-- mas o sistema canonical de vinculação está em product_listings (gerenciado pela
-- UI /catalogo/vinculos com platform='mercadolivre'). 313 vínculos já existem
-- nessa tabela pra Vazzo. Esta versão faz lookup nas duas fontes em ordem:
--   1. product_listings (manual ou via sync) — fonte canonical
--   2. products.sku == ml_campaign_items.seller_sku — fallback automático

CREATE OR REPLACE FUNCTION ml_campaign_items_auto_link_products(p_org_id uuid, p_seller_id bigint DEFAULT NULL)
RETURNS TABLE(linked integer, total integer) AS $$
DECLARE
  v_linked_via_listings integer := 0;
  v_linked_via_sku      integer := 0;
  v_total               integer := 0;
BEGIN
  -- Conta total ainda sem product_id
  SELECT COUNT(*) INTO v_total
  FROM ml_campaign_items
  WHERE organization_id = p_org_id
    AND product_id IS NULL
    AND (p_seller_id IS NULL OR seller_id = p_seller_id);

  -- 1. Lookup via product_listings (fonte canonical, populada pela UI manual)
  WITH matched AS (
    UPDATE ml_campaign_items i
       SET product_id = pl.product_id,
           updated_at = now()
      FROM product_listings pl
      JOIN products p ON p.id = pl.product_id
     WHERE i.organization_id = p_org_id
       AND i.product_id IS NULL
       AND pl.listing_id = i.ml_item_id
       AND pl.platform IN ('mercadolivre', 'ML')
       AND pl.is_active = true
       AND p.organization_id = i.organization_id
       AND (p_seller_id IS NULL OR i.seller_id = p_seller_id)
    RETURNING i.id
  )
  SELECT COUNT(*) INTO v_linked_via_listings FROM matched;

  -- 2. Fallback: match via SKU (pra items que não tinham product_listing)
  WITH matched AS (
    UPDATE ml_campaign_items i
       SET product_id = p.id,
           updated_at = now()
      FROM products p
     WHERE i.organization_id = p_org_id
       AND i.product_id IS NULL
       AND i.seller_sku IS NOT NULL
       AND p.organization_id = i.organization_id
       AND p.sku = i.seller_sku
       AND (p_seller_id IS NULL OR i.seller_id = p_seller_id)
    RETURNING i.id
  )
  SELECT COUNT(*) INTO v_linked_via_sku FROM matched;

  RETURN QUERY SELECT (v_linked_via_listings + v_linked_via_sku), v_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
