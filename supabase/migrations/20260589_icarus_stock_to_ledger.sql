-- Sessão 2026-05-19 (e-Click Saas 23) — Estoque unificado, Fase 1.
--
-- O Icarus (ERP do fornecedor de dropship) escrevia o estoque direto em
-- products.stock, sem passar pelo ledger product_stock — então o motor de
-- estoque enxergava números defasados (210 de 1.566 produtos divergentes).
--
-- A partir da Fase 1 o sync e o cron do Icarus gravam no ledger
-- (product_stock, linha-mestre platform=NULL) e chamam recalcAndPropagate.
-- Esta migration faz o realinhamento único: traz o estoque atual do
-- fornecedor (supplier_products.partner_stock) pro ledger e reespelha
-- products.stock a partir do disponível calculado.

-- ── 1. Ledger ← estoque atual do fornecedor ─────────────────────────────────
UPDATE public.product_stock ps
SET quantity         = GREATEST(0, round(sp.partner_stock)),
    last_movement_at = now(),
    updated_at       = now()
FROM public.supplier_products sp
WHERE sp.product_id = ps.product_id
  AND ps.platform IS NULL
  AND sp.partner_stock IS NOT NULL
  AND sp.supplier_id IN (
    SELECT supplier_id FROM public.supplier_integrations
    WHERE integration_type = 'icarus'
  );

-- ── 2. products.stock ← disponível calculado (espelho) ──────────────────────
-- Mesma fórmula do StockService.calculateAvailable:
--   available = MAX(0, físico + virtual − reservado − segurança)
UPDATE public.products p
SET stock = GREATEST(0, round(
      ps.quantity
      + COALESCE(ps.virtual_quantity, 0)
      - COALESCE(ps.reserved_quantity, 0)
      - CASE WHEN ps.safety_mode = 'percentage'
             THEN round(ps.quantity * COALESCE(ps.safety_percentage, 10) / 100.0)
             ELSE COALESCE(ps.safety_quantity, 0) END
    ))::integer,
    updated_at = now()
FROM public.product_stock ps
WHERE ps.product_id = p.id
  AND ps.platform IS NULL
  AND p.id IN (
    SELECT sp.product_id FROM public.supplier_products sp
    WHERE sp.supplier_id IN (
      SELECT supplier_id FROM public.supplier_integrations
      WHERE integration_type = 'icarus'
    )
  );
