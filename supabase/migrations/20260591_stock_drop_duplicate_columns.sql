-- Sessão 2026-05-19 (e-Click Saas 23) — Estoque unificado, Fase 4 (limpeza).
--
-- product_stock tinha colunas duplicadas: reserved/reserved_quantity e
-- min_stock/min_stock_to_pause. As "curtas" estavam 100% zeradas (0 dados
-- em 2.612 linhas) e sem uso no código — fonte de bug silencioso. Ficam só
-- as canônicas: reserved_quantity e min_stock_to_pause.
--
-- A view v_stock_summary referenciava ps.reserved; repontamos pra
-- reserved_quantity (mantendo o nome de saída 'reserved') antes de dropar.

-- ── 1. Repontar a view pra coluna canônica ──────────────────────────────────
CREATE OR REPLACE VIEW public.v_stock_summary AS
SELECT
  p.id   AS product_id,
  p.name,
  p.sku,
  ps.id  AS stock_id,
  ps.platform,
  ps.account_id,
  ps.quantity AS physical_qty,
  ps.virtual_quantity,
  ps.min_stock_to_pause,
  ps.auto_pause_enabled,
  ps.quantity + ps.virtual_quantity AS platform_qty,
  (ps.quantity <= ps.min_stock_to_pause AND ps.auto_pause_enabled) AS should_pause,
  ps.reserved_quantity AS reserved,
  ps.last_movement_at
FROM public.products p
JOIN public.product_stock ps ON ps.product_id = p.id;

-- ── 2. Dropar as colunas duplicadas ─────────────────────────────────────────
ALTER TABLE public.product_stock DROP COLUMN IF EXISTS reserved;
ALTER TABLE public.product_stock DROP COLUMN IF EXISTS min_stock;
