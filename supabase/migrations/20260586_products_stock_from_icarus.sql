-- Sessão 2026-05-18 (e-Click Saas 23) — Preenche o estoque (products.stock)
-- dos produtos da integração Icarus com o estoque do fornecedor
-- (supplier_products.partner_stock). Daqui pra frente o sync e o cron de
-- estoque (15 min) mantêm o products.stock atualizado.

UPDATE public.products p
SET stock = GREATEST(0, round(sp.partner_stock))::integer,
    updated_at = now()
FROM public.supplier_products sp
WHERE sp.product_id = p.id
  AND sp.organization_id = p.organization_id
  AND sp.partner_stock IS NOT NULL
  AND sp.supplier_id IN (
    SELECT supplier_id FROM public.supplier_integrations WHERE integration_type = 'icarus'
  );
