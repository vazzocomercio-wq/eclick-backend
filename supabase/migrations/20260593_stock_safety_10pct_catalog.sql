-- Sessão 2026-05-19 (e-Click Saas 23) — Estoque de segurança padronizado.
--
-- Decisão do lojista: 10% de estoque de segurança em TODO o catálogo.
-- Estado anterior: 313 produtos já em percentage/10% (registros legados,
-- de antes da Fase 0) e 2.299 em fixed/0% (backfill da Fase 0). Esta
-- migration unifica todos em percentage / 10%.
--
-- Efeito: o disponível pra venda passa a ser 90% do físico. Os anúncios
-- ML recebem o novo número via recalcAndPropagate (cron de reconciliação
-- 04:00, sync do Icarus, venda, ou "Sincronizar Tudo" manual).

-- ── 1. Padronizar a segurança em 10% ────────────────────────────────────────
UPDATE public.product_stock
SET safety_mode       = 'percentage',
    safety_percentage = 10,
    updated_at        = now()
WHERE platform IS NULL
  AND (safety_mode IS DISTINCT FROM 'percentage' OR safety_percentage IS DISTINCT FROM 10);

-- ── 2. Re-espelhar products.stock com o novo disponível ─────────────────────
-- available = MAX(0, físico + virtual − reservado − segurança 10%)
UPDATE public.products p
SET stock = GREATEST(0, round(
      ps.quantity
      + COALESCE(ps.virtual_quantity, 0)
      - COALESCE(ps.reserved_quantity, 0)
      - round(ps.quantity * 10.0 / 100)
    ))::integer,
    updated_at = now()
FROM public.product_stock ps
WHERE ps.product_id = p.id
  AND ps.platform IS NULL;
