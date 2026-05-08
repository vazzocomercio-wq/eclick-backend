-- Adiciona seller_sku em ml_campaign_items pra fazer auto-match com
-- products.sku. Sem esse vinculo, health_status fica INCOMPLETE pra
-- sempre porque nao acha custo/imposto cadastrado no catalogo.

ALTER TABLE ml_campaign_items
  ADD COLUMN IF NOT EXISTS seller_sku text;

CREATE INDEX IF NOT EXISTS idx_camp_items_seller_sku
  ON ml_campaign_items(organization_id, seller_sku)
  WHERE seller_sku IS NOT NULL;

-- Funcao auxiliar pra auto-link via SKU (chamada apos enrichment).
-- Usa LATERAL pra fazer 1 query atomica que casa items <-> products
-- por (organization_id, sku == seller_sku).
CREATE OR REPLACE FUNCTION ml_campaign_items_auto_link_products(p_org_id uuid, p_seller_id bigint DEFAULT NULL)
RETURNS TABLE(linked integer, total integer) AS $$
DECLARE
  v_linked  integer := 0;
  v_total   integer := 0;
BEGIN
  -- Conta total ainda sem product_id
  SELECT COUNT(*) INTO v_total
  FROM ml_campaign_items
  WHERE organization_id = p_org_id
    AND product_id IS NULL
    AND seller_sku IS NOT NULL
    AND (p_seller_id IS NULL OR seller_id = p_seller_id);

  -- Faz o link via UPDATE FROM
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
  SELECT COUNT(*) INTO v_linked FROM matched;

  RETURN QUERY SELECT v_linked, v_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION ml_campaign_items_auto_link_products(uuid, bigint) TO authenticated, service_role;
