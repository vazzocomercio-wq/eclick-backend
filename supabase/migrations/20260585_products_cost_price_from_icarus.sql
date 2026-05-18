-- Sessão 2026-05-18 (e-Click Saas 23) — Preenche o CMV (products.cost_price)
-- dos produtos da integração Icarus com o custo líquido do fornecedor
-- (preço da Pennacorp menos o desconto), que vive em supplier_products.unit_cost.
-- Daqui pra frente o backend mantém o cost_price sincronizado.

UPDATE public.products p
SET cost_price = sp.unit_cost,
    updated_at = now()
FROM public.supplier_products sp
WHERE sp.product_id = p.id
  AND sp.organization_id = p.organization_id
  AND sp.unit_cost IS NOT NULL
  AND sp.supplier_id IN (
    SELECT supplier_id FROM public.supplier_integrations WHERE integration_type = 'icarus'
  );
